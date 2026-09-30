/* Daily Board 04 - engine
 * Pure logic, no DOM. Loaded as a classic script; exposes window.T04.
 *  1. reading / state machine (same transitions as the public reference adapter)
 *  2. failure classification for real fetches + user-facing messages
 *  3. public package check: read the official ZIP in the browser and compare SHA-256
 */
(function (root) {
  'use strict';

  const NORMALIZED_KEYS = ['signal_id', 'normalized_value', 'unit', 'source_name', 'source_url',
    'source_time', 'fetched_at', 'record_timezone', 'record_date'];
  const ERROR_CODES = ['timeout', 'auth', 'rate_limit', 'offline', 'schema_error'];

  const clone = v => JSON.parse(JSON.stringify(v));

  function kstDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw new TypeError('fetched_at must be a valid ISO-8601 date-time');
    const p = Object.fromEntries(new Intl.DateTimeFormat('en', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }

  /* ---------- 1. reading + state ---------- */

  function validateNormalizedReading(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new TypeError('reading must be an object');
    const a = Object.keys(r).sort(), e = [...NORMALIZED_KEYS].sort();
    if (a.length !== e.length || a.some((k, i) => k !== e[i])) throw new TypeError('reading keys must be exactly: ' + NORMALIZED_KEYS.join(', '));
    if (typeof r.signal_id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(r.signal_id) || r.signal_id.length > 100) throw new TypeError('signal_id is invalid');
    if (typeof r.normalized_value !== 'number' || !Number.isFinite(r.normalized_value)) throw new TypeError('normalized_value must be a finite number (got ' + typeof r.normalized_value + ')');
    for (const f of ['unit', 'source_name']) {
      if (typeof r[f] !== 'string' || r[f].trim() === '') throw new TypeError(f + ' must be a non-empty string');
    }
    let u;
    try { u = new URL(r.source_url); } catch (_) { throw new TypeError('source_url must be an absolute URL'); }
    if (u.protocol !== 'https:') throw new TypeError('source_url must use HTTPS');
    if (r.source_time !== null && Number.isNaN(new Date(r.source_time).getTime())) throw new TypeError('source_time must be a valid date-time or null');
    if (Number.isNaN(new Date(r.fetched_at).getTime())) throw new TypeError('fetched_at must be a valid date-time');
    if (r.record_timezone !== 'Asia/Seoul') throw new TypeError('record_timezone must be Asia/Seoul');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.record_date) || r.record_date !== kstDate(r.fetched_at)) throw new TypeError('record_date must be the Asia/Seoul date of fetched_at');
    return true;
  }

  function resetState() {
    return {
      schema_version: 'aleph-t04-evaluation-state-v1',
      daily_readings: [], current_reading: null, status: null, last_delta: null,
      last_comparison: { state: 'insufficient', direction: null, magnitude: null, unit: null },
      last_run: null, sequence: 0
    };
  }

  function comparisonFor(rows, cur) {
    const prev = rows.filter(r => r.signal_id === cur.signal_id && r.record_date < cur.record_date)
      .sort((a, b) => b.record_date.localeCompare(a.record_date))[0];
    if (!prev) return { state: 'insufficient', direction: null, magnitude: null, unit: null };
    if (prev.unit !== cur.unit) return { state: 'unit_mismatch', direction: null, magnitude: null, unit: null };
    const s = cur.normalized_value - prev.normalized_value;
    return { state: 'comparable', direction: s > 0 ? 'increase' : s < 0 ? 'decrease' : 'unchanged', magnitude: Math.abs(s), unit: cur.unit, previous_value: prev.normalized_value, previous_date: prev.record_date, signed: s };
  }

  function applySuccessfulReading(input, reading, meta) {
    meta = meta || {};
    validateNormalizedReading(reading);
    const st = clone(input);
    const i = st.daily_readings.findIndex(r => r.signal_id === reading.signal_id && r.record_date === reading.record_date);
    const ex = i >= 0 ? st.daily_readings[i] : null;
    const row = {
      record_id: ex ? ex.record_id : `demo-${reading.signal_id}-${reading.record_date}`,
      signal_id: reading.signal_id, record_date: reading.record_date,
      normalized_value: reading.normalized_value, unit: reading.unit,
      first_fetched_at: ex ? ex.first_fetched_at : reading.fetched_at,
      last_fetched_at: reading.fetched_at, reading: clone(reading)
    };
    if (i >= 0) st.daily_readings[i] = row; else st.daily_readings.push(row);
    st.daily_readings.sort((a, b) => a.record_date.localeCompare(b.record_date));
    st.current_reading = clone(reading);
    st.status = { freshness: 'fresh', error_code: 'none' };
    st.last_comparison = comparisonFor(st.daily_readings, row);
    st.last_delta = st.last_comparison.magnitude;
    st.sequence += 1;
    st.last_run = { fixture_id: meta.fixture_id || null, virtual_now: meta.virtual_now || reading.fetched_at, outcome: 'success', error_code: 'none', retry_after_seconds: null };
    return st;
  }

  function applyError(input, code, meta) {
    meta = meta || {};
    if (!ERROR_CODES.includes(code)) throw new TypeError('unsupported error code: ' + code);
    const st = clone(input);
    st.status = { freshness: 'stale', error_code: code };
    st.sequence += 1;
    st.last_run = { fixture_id: meta.fixture_id || null, virtual_now: meta.virtual_now || null, outcome: 'error', error_code: code, retry_after_seconds: meta.retry_after_seconds == null ? null : meta.retry_after_seconds, detail: meta.detail || null };
    return st;
  }

  function runFixture(input, fx) {
    const t = fx.transport;
    const meta = { fixture_id: fx.fixture_id, virtual_now: fx.virtual_now, retry_after_seconds: t.headers && t.headers['retry-after'] ? Number(t.headers['retry-after']) : null };
    if (t.mode === 'timeout') return applyError(input, 'timeout', Object.assign(meta, { detail: `응답 지연 ${t.delay_ms}ms > 제한 ${t.deadline_ms}ms` }));
    if (t.mode === 'offline') return applyError(input, 'offline', Object.assign(meta, { detail: '네트워크 연결 없음' }));
    if (t.status === 401 || t.status === 403) return applyError(input, 'auth', Object.assign(meta, { detail: 'HTTP ' + t.status }));
    if (t.status === 429) return applyError(input, 'rate_limit', Object.assign(meta, { detail: 'HTTP 429' }));
    if (t.status >= 200 && t.status < 300) {
      try { return applySuccessfulReading(input, fx.payload, meta); }
      catch (e) { return applyError(input, 'schema_error', Object.assign(meta, { detail: e.message })); }
    }
    return applyError(input, 'schema_error', Object.assign(meta, { detail: 'unexpected HTTP ' + t.status }));
  }

  /* Compare a state with the fixture's own `expected` block. */
  function checkExpected(state, fx, ctx) {
    ctx = ctx || {};
    const ex = fx.expected, rows = state.daily_readings, checks = [];
    const add = (name, want, got) => checks.push({ name, want, got, ok: JSON.stringify(want) === JSON.stringify(got) });
    add('freshness', ex.freshness, state.status && state.status.freshness);
    add('error_code', ex.error_code, state.status && state.status.error_code);
    add('row_count', ex.row_count, rows.length);
    add('stored_value', ex.stored_value, state.current_reading ? state.current_reading.normalized_value : null);
    add('delta', ex.delta, state.last_delta);
    if (ex.record_date) add('record_date', ex.record_date, state.current_reading ? state.current_reading.record_date : null);
    if (ex.same_record_id_as && ctx.recordIds) add('same_record_id_as ' + ex.same_record_id_as, ctx.recordIds[ex.same_record_id_as], rows.length ? rows[rows.length - 1].record_id : null);
    if (ex.preserve_last_good) add('preserve_last_good', true, !!state.current_reading);
    return { ok: checks.every(c => c.ok), checks };
  }

  /* ---------- 2. real-fetch failure classification + messages ---------- */

  function classifyFetchFailure(err, response) {
    if (response) {
      if (response.status === 401 || response.status === 403) return { code: 'auth', detail: 'HTTP ' + response.status };
      if (response.status === 429) return { code: 'rate_limit', detail: 'HTTP 429', retry_after: Number(response.headers.get('retry-after')) || null };
      if (!response.ok) return { code: 'schema_error', detail: 'unexpected HTTP ' + response.status };
    }
    if (err && err.name === 'AbortError') return { code: 'timeout', detail: '제한시간 8초 안에 응답 없음' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { code: 'offline', detail: '브라우저가 오프라인 상태로 보고함' };
    if (err && err.name === 'TypeError' && !(err instanceof SyntaxError)) return { code: 'offline', detail: '출처까지 요청이 도달하지 못함' };
    return { code: 'schema_error', detail: err ? err.message : 'unknown' };
  }

  function humanizeSchema(d) {
    let m = /normalized_value must be a finite number \(got (\w+)\)/.exec(d);
    if (m) return `값(normalized_value)이 숫자가 아니라 ${m[1] === 'string' ? '문자' : m[1]}로 왔어요`;
    if (/normalized_value/.test(d)) return '값(normalized_value)이 올바른 숫자가 아니에요';
    m = /^(\w+) must be a non-empty string/.exec(d);
    if (m) return `${m[1]} 항목이 비어 있거나 문자가 아니에요`;
    if (/keys must be exactly/.test(d)) return '응답의 항목 구성이 약속과 달라요';
    if (/source_url/.test(d)) return '출처 주소(source_url) 형식이 올바르지 않아요';
    if (/record_date|record_timezone/.test(d)) return '기록 날짜·시간대 항목이 올바르지 않아요';
    return d;
  }

  const FAILURES = {
    timeout: {
      label: '느림', short: '시간 초과', glyph: '⏱', tone: 'amber',
      headline: '출처가 제한시간 안에 답하지 않았어요',
      what: d => `요청을 보낸 뒤 정해 둔 시간 안에 응답이 오지 않아 기다리기를 멈췄어요.${d ? ' (' + d + ')' : ''} 값이 틀린 게 아니라 아직 못 받은 거예요.`,
      fault: '출처 서버나 중간 네트워크가 느린 경우',
      user: ['잠시 뒤 “다시 시도”를 눌러 보세요.'],
      operator: ['계속 느리면 출처 서버 상태를 확인하고 제한시간 설정을 점검해요.']
    },
    auth: {
      label: '거절', short: '401·403', glyph: '⛔', tone: 'red',
      headline: '출처가 이 요청을 받아 주지 않았어요',
      what: d => `출처가 인증·권한 문제(${d || 'HTTP 401/403'})로 요청을 거절했어요. 이 정보판에는 로그인이 없어요. 출처가 접근 조건을 바꿨거나 막았다는 뜻이에요.`,
      fault: '출처 쪽 접근 정책',
      user: ['기다려도 저절로 풀리지 않을 수 있어요. 다시 시도는 해 볼 수 있어요.'],
      operator: ['출처의 이용 조건(키 필요 여부, 접근 허용 범위)이 바뀌었는지 확인해요.', '키가 필요해졌다면 브라우저가 아니라 서버 환경변수로만 다뤄요.']
    },
    rate_limit: {
      label: '호출 제한', short: '429', glyph: '🚦', tone: 'amber',
      headline: '너무 자주 불러서 출처가 잠시 막았어요',
      what: (d, ra) => `출처가 호출 횟수 제한(HTTP 429)으로 답했어요.${ra ? ` 출처가 ${ra}초 뒤에 다시 하라고 알려 줬어요(Retry-After).` : ''}`,
      fault: '요청이 짧은 시간에 몰린 경우',
      user: ['안내된 시간을 기다린 뒤 “다시 시도”를 눌러 주세요.', '연속으로 누르면 제한이 길어질 수 있어요.'],
      operator: ['조회 간격을 늘리거나 캐시를 두어 호출 횟수를 줄여요.']
    },
    offline: {
      label: '오프라인', short: '연결 없음', glyph: '📡', tone: 'slate',
      headline: '이 기기가 인터넷에 연결되어 있지 않아요',
      what: () => '요청이 출처까지 가지 못했어요. 출처의 문제가 아니라 이쪽 연결의 문제예요.',
      fault: '사용자 기기의 네트워크',
      user: ['Wi-Fi나 모바일 데이터 연결을 확인해요.', '연결이 돌아오면 “다시 시도”를 눌러요.'],
      operator: []
    },
    schema_error: {
      label: '형식 변경', short: '응답 모양 다름', glyph: '🧩', tone: 'violet',
      headline: '출처는 답했지만 값의 모양이 약속과 달라요',
      what: d => `응답을 받았지만 약속한 형식과 달라서 저장하지 않았어요.${d ? ' 이유: ' + humanizeSchema(d) + '.' : ''} 잘못된 값이 기록에 섞이지 않도록 막은 거예요.`,
      fault: '출처가 응답 형식을 바꾼 경우',
      user: ['다시 시도해도 같은 모양이면 사용자가 할 수 있는 일은 없어요.'],
      operator: ['출처의 응답 예시와 읽기 코드를 비교해 형식 변경을 반영해요.']
    }
  };

  /* ---------- 3. public package check ---------- */

  async function sha256hex(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 압축 해제(DecompressionStream)를 지원하지 않습니다');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readZip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP 끝 표식을 찾지 못했습니다');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    const files = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 중앙 디렉터리가 손상됐습니다');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      const lnlen = dv.getUint16(lho + 26, true), lxlen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lnlen + lxlen, raw = u8.subarray(start, start + csize);
      files.set(name, method === 0 ? raw.slice() : method === 8 ? await inflateRaw(raw) : (() => { throw new Error('지원하지 않는 압축 방식 ' + method); })());
    }
    return files;
  }

  function canonicalJson(v) {
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }

  /* Load the official package from the ZIP, verify every file, return fixtures. */
  async function loadPackage(zipUrl) {
    const res = await fetch(zipUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error('패키지 ZIP을 받지 못했습니다 (HTTP ' + res.status + ')');
    const buf = await res.arrayBuffer();
    const zipSha = await sha256hex(new Uint8Array(buf));
    const all = await readZip(buf);
    const rootDir = [...all.keys()][0].split('/')[0] + '/';
    const get = name => all.get(rootDir + name);
    const text = name => new TextDecoder().decode(get(name));
    const manifest = JSON.parse(text('asset-manifest.json'));
    const files = [];
    for (const f of manifest.files) {
      const b = get(f.path);
      const actual = b ? await sha256hex(b) : null;
      files.push({ path: f.path, bytes_expected: f.bytes, bytes_actual: b ? b.length : null, sha256_expected: f.sha256, sha256_actual: actual, ok: !!b && actual === f.sha256 && b.length === f.bytes });
    }
    const listed = new Set(manifest.files.map(f => f.path).concat(['asset-manifest.json']));
    const extra = [...all.keys()].map(k => k.slice(rootDir.length)).filter(k => !listed.has(k));
    const contract = JSON.parse(text('public-contract.json'));
    const fxManifest = JSON.parse(text('fixture-manifest.json'));
    const fixtures = {}, canonical = [];
    for (const m of fxManifest.fixtures) {
      const obj = JSON.parse(text('fixtures/' + m.file));
      fixtures[m.fixture_id] = obj;
      const h = 'sha256-' + await sha256hex(new TextEncoder().encode(canonicalJson(obj)));
      canonical.push({ fixture_id: m.fixture_id, ok: h === m.canonical_sha256, expected: m.canonical_sha256, actual: h });
    }
    return {
      package_id: manifest.package_id, contract_version: contract.contract_version, fixture_contract_version: contract.fixture_contract.version,
      zip_sha256: zipSha, zip_bytes: buf.byteLength, entry_count: all.size, entry_count_expected: manifest.delivery_archive.entry_count,
      files, canonical, extra_entries: extra, contract, fixtures,
      ok: files.every(f => f.ok) && canonical.every(c => c.ok) && extra.length === 0 && all.size === manifest.delivery_archive.entry_count
    };
  }

  /* ---------- 4. daily key: one row per signal_id + Asia/Seoul date ---------- */

  const utcDate = iso => new Date(iso).toISOString().slice(0, 10);

  function kstClock(iso) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }

  /* Apply readings one by one to a fresh state and record what happened to the row count.
   * steps: [{label, source, reading}]  ->  { state, trace[] } */
  function runDailySeries(steps) {
    let st = resetState();
    const trace = [];
    for (const s of steps) {
      const r = s.reading, before = st.daily_readings.length;
      const existing = st.daily_readings.find(x => x.signal_id === r.signal_id && x.record_date === r.record_date);
      let action, error = null;
      try {
        st = applySuccessfulReading(st, r, { fixture_id: s.label });
        action = existing ? 'update' : 'insert';
      } catch (e) { action = 'reject'; error = e.message; }
      const row = st.daily_readings.find(x => x.signal_id === r.signal_id && x.record_date === r.record_date);
      trace.push({
        label: s.label, source: s.source || '', fetched_at: r.fetched_at,
        utc_date: utcDate(r.fetched_at), kst_clock: kstClock(r.fetched_at), kst_date: kstDate(r.fetched_at), key_date: r.record_date,
        action, error, rows_before: before, rows_after: st.daily_readings.length,
        value: r.normalized_value, record_id: row ? row.record_id : null,
        first_fetched_at: row ? row.first_fetched_at : null, last_fetched_at: row ? row.last_fetched_at : null
      });
    }
    return { state: st, trace };
  }

  root.T04 = {
    utcDate, kstClock, runDailySeries,
    ERROR_CODES, FAILURES, kstDate, resetState, validateNormalizedReading, applySuccessfulReading, applyError,
    runFixture, checkExpected, classifyFetchFailure, comparisonFor, loadPackage, sha256hex, canonicalJson
  };
})(window);

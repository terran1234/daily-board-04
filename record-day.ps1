# Record one USD/KRW reading per Asia/Seoul (KST) date. No API key, no secrets.
#
#   pwsh ./record-day.ps1                         (real run: calls the public source)
#
# Rules
#   - key = signal_id + KST date. Same key again -> update the same row (first_fetched_at and record_id stay).
#   - Next KST date -> new row.
#   - The raw response is saved as-is to data/raw/<KST date>.json.
#   - Nothing is written when the response is not a valid success response.
#   - -MaxDays caps the number of DIFFERENT real dates kept (course task needs exactly 2).
#     Updating a date that is already stored is always allowed.
#
# Test-only parameters (never used by the scheduled run):
#   -DataDir  write somewhere else, -RawFile read this file instead of calling the network,
#   -AsOf     synthetic clock (ISO-8601 UTC).
param(
  [string]$DataDir = '',
  [string]$RawFile = '',
  [string]$AsOf = '',
  [int]$MaxDays = 2
)
$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture
if (-not $DataDir) { $DataDir = Join-Path $PSScriptRoot 'data' }
$url = 'https://open.er-api.com/v6/latest/USD'
$signal = 'usd-krw'
$unit = 'KRW per 1 USD'
$utf8 = New-Object Text.UTF8Encoding($false)
$fmtZ = "yyyy-MM-dd'T'HH:mm:ss'Z'"

# ---- 1. get the raw response ----
if ($AsOf) { $fetched = [DateTimeOffset]::Parse($AsOf, $inv, [Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime() }
else { $fetched = [DateTimeOffset]::UtcNow }
if ($RawFile) {
  $rawText = [IO.File]::ReadAllText($RawFile, $utf8)
} else {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 20
  $rawText = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
}

# ---- 2. validate before touching any file ----
$j = $rawText | ConvertFrom-Json
if ($j.result -ne 'success') { throw 'source did not answer success: nothing saved' }
if ($null -eq $j.rates -or $null -eq $j.rates.KRW -or -not ($j.rates.KRW -is [ValueType])) { throw 'KRW rate missing or not a number: nothing saved' }
if ($null -eq $j.time_last_update_unix -or -not ($j.time_last_update_unix -is [ValueType])) { throw 'time_last_update_unix missing: nothing saved' }
$value = [double]$j.rates.KRW
$sourceTime = [DateTimeOffset]::FromUnixTimeSeconds([int64]$j.time_last_update_unix)

# ---- 3. KST date key (made once, here) ----
$kst = [TimeSpan]::FromHours(9)
$kstDate = $fetched.ToOffset($kst).ToString('yyyy-MM-dd', $inv)
$fmtKst = "yyyy-MM-dd'T'HH:mm:ssK"

New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'raw') | Out-Null
$dailyPath = Join-Path $DataDir 'daily.json'
# PowerShell 7 turns ISO date strings into DateTime objects while reading JSON; write them back in one fixed format.
function ToZ($v) {
  if ($v -is [datetime]) { return ([DateTimeOffset]$v).ToUniversalTime().ToString($fmtZ, $inv) }
  return [string]$v
}
function NormRow($r) {
  [pscustomobject][ordered]@{
    record_id = [string]$r.record_id; signal_id = [string]$r.signal_id; record_date = [string]$r.record_date
    record_timezone = [string]$r.record_timezone; normalized_value = [double]$r.normalized_value; unit = [string]$r.unit
    source_name = [string]$r.source_name; source_url = [string]$r.source_url; source_time = (ToZ $r.source_time)
    first_fetched_at = (ToZ $r.first_fetched_at); last_fetched_at = (ToZ $r.last_fetched_at); raw_file = [string]$r.raw_file
  }
}
$rows = @()
if (Test-Path $dailyPath) {
  # Windows PowerShell 5.1 returns a JSON array as one object; unroll it so every row is its own item.
  $parsed = [IO.File]::ReadAllText($dailyPath, $utf8) | ConvertFrom-Json
  $rows = @($parsed | ForEach-Object { NormRow $_ })
}
$before = $rows.Count
$existing = $rows | Where-Object { $_.record_date -eq $kstDate } | Select-Object -First 1

# ---- 4. cap on different real dates ----
if (-not $existing -and $MaxDays -gt 0 -and $before -ge $MaxDays) {
  "record_date=$kstDate action=skip rows=$before (limit of $MaxDays different dates reached; nothing written)"
  exit 0
}

# ---- 5. upsert the daily row ----
$row = [ordered]@{
  record_id        = if ($existing) { $existing.record_id } else { "$signal-$kstDate" }
  signal_id        = $signal
  record_date      = $kstDate
  record_timezone  = 'Asia/Seoul'
  normalized_value = $value
  unit             = $unit
  source_name      = 'ExchangeRate-API (open.er-api.com)'
  source_url       = $url
  source_time      = $sourceTime.ToString($fmtZ, $inv)
  first_fetched_at = if ($existing) { $existing.first_fetched_at } else { $fetched.ToString($fmtZ, $inv) }
  last_fetched_at  = $fetched.ToString($fmtZ, $inv)
  raw_file         = "data/raw/$kstDate.json"
}
$out = @($rows | Where-Object { $_.record_date -ne $kstDate }) + @([pscustomobject]$row)
$out = @($out | Sort-Object record_date)
[IO.File]::WriteAllText($dailyPath, ((ConvertTo-Json -InputObject $out -Depth 5) + "`n"), $utf8)

# ---- 6. raw response as received + latest.json (same shape as before) ----
[IO.File]::WriteAllText((Join-Path $DataDir "raw/$kstDate.json"), $rawText, $utf8)
$latest = [ordered]@{
  pair            = 'USD/KRW'
  value           = $value
  unit            = $unit
  source_name     = 'ExchangeRate-API (open.er-api.com)'
  source_url      = $url
  source_time_utc = $sourceTime.ToString($fmtZ, $inv)
  source_time_kst = $sourceTime.ToOffset($kst).ToString($fmtKst, $inv)
  fetched_at_utc  = $fetched.ToString($fmtZ, $inv)
  fetched_at_kst  = $fetched.ToOffset($kst).ToString($fmtKst, $inv)
  timezone        = 'Asia/Seoul (KST, UTC+9)'
  kst_date        = $kstDate
}
[IO.File]::WriteAllText((Join-Path $DataDir 'latest.json'), ((ConvertTo-Json -InputObject $latest) + "`n"), $utf8)

$action = if ($existing) { 'update' } else { 'insert' }
"record_date=$kstDate action=$action rows_before=$before rows_after=$($out.Count) value=$($value.ToString($inv))"

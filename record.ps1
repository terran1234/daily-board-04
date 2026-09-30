# USD/KRW 정상 응답 한 건을 원자료 그대로 + 저장값으로 남긴다. 비밀키 없음.
# 실행: pwsh scripts/record.ps1   (Windows PowerShell 5.1도 가능)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url  = 'https://open.er-api.com/v6/latest/USD'

$fetched = [DateTimeOffset]::UtcNow
$resp = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 20
$rawText = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
$j = $rawText | ConvertFrom-Json

if ($j.result -ne 'success' -or $null -eq $j.rates.KRW) { throw 'not a valid success response: nothing saved' }

$kst = [TimeSpan]::FromHours(9)
$src = [DateTimeOffset]::FromUnixTimeSeconds([int64]$j.time_last_update_unix)
$fmt = "yyyy-MM-dd'T'HH:mm:ssK"

$stored = [ordered]@{
  pair            = 'USD/KRW'
  value           = [double]$j.rates.KRW
  unit            = 'KRW per 1 USD'
  source_name     = 'ExchangeRate-API (open.er-api.com)'
  source_url      = $url
  source_time_utc = $src.ToString($fmt)
  source_time_kst = $src.ToOffset($kst).ToString($fmt)
  fetched_at_utc  = $fetched.ToString($fmt)
  fetched_at_kst  = $fetched.ToOffset($kst).ToString($fmt)
  timezone        = 'Asia/Seoul (KST, UTC+9)'
  kst_date        = $fetched.ToOffset($kst).ToString('yyyy-MM-dd')
}

New-Item -ItemType Directory -Force -Path "$root\data\raw" | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText("$root\data\raw\$($stored.kst_date).json", $rawText, $utf8)
[IO.File]::WriteAllText("$root\data\latest.json", ($stored | ConvertTo-Json), $utf8)
"saved: $($stored.kst_date) USD/KRW = $($stored.value)"

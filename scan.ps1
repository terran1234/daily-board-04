# Scan repo files (and optionally the deployed site) for secret-looking text.
# Usage:
#   powershell -File scan.ps1
#   powershell -File scan.ps1 -BaseUrl https://terran1234.github.io/daily-board-04
# Prints only file, line and pattern name. It never prints the matched text.
param([string]$BaseUrl = '')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# name -> regex
$patterns = [ordered]@{
  'github-token'      = 'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'
  'aws-access-key'    = 'AKIA[0-9A-Z]{16}'
  'openai-style-key'  = 'sk-[A-Za-z0-9_-]{20,}'
  'google-api-key'    = 'AIza[0-9A-Za-z_-]{30,}'
  'slack-token'       = 'xox[baprs]-[A-Za-z0-9-]{10,}'
  'private-key-block' = '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'bearer-token'      = '(?i)bearer\s+[A-Za-z0-9._~+/=-]{16,}'
  'auth-header'       = '(?i)authorization\s*[:=]'
  'key-assignment'    = '(?i)(api[_-]?key|apikey|secret|passwd|password|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*[''"]?[A-Za-z0-9._~+/=-]{8,}'
  'key-in-url'        = '(?i)[?&](api[_-]?key|apikey|key|token|access_token|secret|appid|app_id)='
}

function Scan-Text([string]$name, [string]$text) {
  $hits = @()
  $lines = $text -split "`n"
  for ($i = 0; $i -lt $lines.Length; $i++) {
    foreach ($p in $patterns.Keys) {
      if ($lines[$i] -match $patterns[$p]) { $hits += "{0}:{1}  [{2}]" -f $name, ($i + 1), $p }
    }
  }
  return $hits
}

$all = @()
$count = 0
Get-ChildItem $root -Recurse -File -Force |
  Where-Object { $_.FullName -notmatch '\\(\.git|\.claude)\\' } |
  ForEach-Object {
    $count++
    $rel = $_.FullName.Substring($root.Length + 1)
    $all += Scan-Text $rel ([IO.File]::ReadAllText($_.FullName))
  }
"local files scanned : $count"

if ($BaseUrl) {
  $paths = 'index.html','README.md','scripts/record.ps1','scan.ps1','data/latest.json'
  $paths += Get-ChildItem "$root\data\raw" -File | ForEach-Object { "data/raw/$($_.Name)" }
  $n = 0
  foreach ($p in $paths) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri ("$BaseUrl/$p") -TimeoutSec 20
      $n++
      $all += Scan-Text ("deployed:$p") $r.Content
    } catch { "deployed file not found (skipped): $p" }
  }
  "deployed files scanned: $n"
}

"matches: $($all.Count)"
$all
if ($all.Count -gt 0) { exit 1 }

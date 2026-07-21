param(
  [string]$ImagePath,
  [string]$BaseUrl = "http://127.0.0.1:8092"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $ImagePath)) {
  throw "Image not found: $ImagePath"
}

$health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health"
$health | ConvertTo-Json -Depth 8

$form = @{
  file = Get-Item -LiteralPath $ImagePath
  frame_id = "smoke-test"
  timestamp_sec = "0"
}

$result = Invoke-RestMethod -Method Post -Uri "$BaseUrl/detect-ui" -Form $form
$result | ConvertTo-Json -Depth 10


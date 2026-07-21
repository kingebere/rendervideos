$ErrorActionPreference = "Stop"

$ServiceRoot = Split-Path -Parent $PSScriptRoot
$ModelsDir = Join-Path $ServiceRoot "models"
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

$SourceRoot = "C:\Users\gudos\Documents\escape docker copy\ml_artifacts"
$Checkpoint = Join-Path $SourceRoot "faster_rcnn_uiland_checkpoint_stopped.pth"
$LabelMap = Join-Path $SourceRoot "ui_detector_label_map.json"

if (!(Test-Path $Checkpoint)) {
  throw "Missing checkpoint: $Checkpoint"
}
if (!(Test-Path $LabelMap)) {
  throw "Missing label map: $LabelMap"
}

Copy-Item -LiteralPath $Checkpoint -Destination (Join-Path $ModelsDir "faster_rcnn_uiland_checkpoint_stopped.pth") -Force
Copy-Item -LiteralPath $LabelMap -Destination (Join-Path $ModelsDir "ui_detector_label_map.json") -Force

Write-Host "Copied detector artifacts into $ModelsDir"


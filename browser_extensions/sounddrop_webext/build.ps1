param(
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$commonDir = Join-Path $root "common"
$manifestDir = Join-Path $root "manifests"
$distDir = Join-Path $root "dist"

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $repoRoot = Resolve-Path (Join-Path $root "..\..")
  $OutputDir = Join-Path $repoRoot "worker\public\downloads"
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Build-Package {
  param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$ZipName
  )

  $targetDir = Join-Path $distDir $Target
  if (Test-Path $targetDir) {
    Remove-Item -Recurse -Force $targetDir
  }
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  Copy-Item -Recurse -Force (Join-Path $commonDir "*") $targetDir
  Copy-Item -Force $ManifestPath (Join-Path $targetDir "manifest.json")

  $zipPath = Join-Path $distDir $ZipName
  if (Test-Path $zipPath) {
    Remove-Item -Force $zipPath
  }

  Compress-Archive -Path (Join-Path $targetDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
  Copy-Item -Force $zipPath (Join-Path $OutputDir $ZipName)

  Write-Host "Built $Target package -> $zipPath"
}

Build-Package -Target "chrome" -ManifestPath (Join-Path $manifestDir "manifest.chrome.json") -ZipName "SoundDrop-Extension-Chrome.zip"
Build-Package -Target "firefox" -ManifestPath (Join-Path $manifestDir "manifest.firefox.json") -ZipName "SoundDrop-Extension-Firefox.zip"

Write-Host "Copied packages to $OutputDir"

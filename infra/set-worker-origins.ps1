param(
  [Parameter(Mandatory = $true)]
  [string]$PrimaryOriginUrl,

  [Parameter(Mandatory = $true)]
  [string]$BackupOriginUrl,

  [string]$WorkerDir = "..\\worker",
  [switch]$Deploy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Normalize-Url {
  param([string]$Url)
  $trimmed = $Url.Trim().TrimEnd('/')
  if (-not ($trimmed -match '^https?://')) {
    throw "Invalid URL: $Url"
  }
  return $trimmed
}

function Set-JsoncVar {
  param(
    [string]$Content,
    [string]$Key,
    [string]$Value
  )

  $escapedValue = $Value.Replace('\', '\\').Replace('"', '\"')
  $pattern = "(?m)(""$([regex]::Escape($Key))""\s*:\s*"")(?:[^""\\]|\\.)*("")"
  if ($Content -match $pattern) {
    return [regex]::Replace($Content, $pattern, "`"$Key`": `"$escapedValue`"")
  }

  throw "Key '$Key' not found in wrangler.jsonc vars section."
}

$primary = Normalize-Url -Url $PrimaryOriginUrl
$backup = Normalize-Url -Url $BackupOriginUrl

$workerPath = Resolve-Path $WorkerDir
$wranglerPath = Join-Path $workerPath "wrangler.jsonc"
if (-not (Test-Path $wranglerPath)) {
  throw "wrangler.jsonc not found: $wranglerPath"
}

$originsJson = @(
  @{ id = "primary"; base_url = $primary; priority = 0 }
  @{ id = "backup"; base_url = $backup; priority = 1 }
) | ConvertTo-Json -Compress

$content = Get-Content -Path $wranglerPath -Raw
$content = Set-JsoncVar -Content $content -Key "DOWNLOADER_API_URL" -Value $primary
$content = Set-JsoncVar -Content $content -Key "DOWNLOADER_BACKUP_API_URL" -Value $backup
$content = Set-JsoncVar -Content $content -Key "DOWNLOADER_ORIGINS_JSON" -Value $originsJson
Set-Content -Path $wranglerPath -Value $content -NoNewline

Write-Output "Updated worker origins in: $wranglerPath"
Write-Output "Primary: $primary"
Write-Output "Backup: $backup"
Write-Output "DOWNLOADER_ORIGINS_JSON: $originsJson"

if ($Deploy) {
  Push-Location $workerPath
  try {
    npx.cmd wrangler deploy --config wrangler.jsonc
  } finally {
    Pop-Location
  }
}

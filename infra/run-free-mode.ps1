Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Info {
  param([string]$Message)
  Write-Output "[sounddrop-free] $Message"
}

function Ensure-Directory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Start-Downloader {
  param([string]$InfraDir)
  Write-Info "Starting downloader container..."
  & docker compose up -d --build
}

function Start-TryCloudflare {
  param(
    [string]$RepoRoot,
    [string]$DownloaderUrl
  )

  $runtimeDir = Join-Path $RepoRoot ".runtime"
  Ensure-Directory -Path $runtimeDir
  $pidFile = Join-Path $runtimeDir "trycloudflare.pid"
  $runSuffix = "{0:yyyyMMdd-HHmmss}-{1}" -f (Get-Date), ([guid]::NewGuid().ToString("N").Substring(0, 8))
  $stdoutLog = Join-Path $runtimeDir "trycloudflare-$runSuffix.out.log"
  $stderrLog = Join-Path $runtimeDir "trycloudflare-$runSuffix.err.log"

  if (Test-Path -LiteralPath $pidFile) {
    try {
      $oldPidRaw = Get-Content -LiteralPath $pidFile -Raw
      $oldPid = [int]::Parse($oldPidRaw.Trim())
      $oldProcess = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
      if ($oldProcess) {
        Write-Info "Stopping previous tunnel PID $oldPid..."
        Stop-Process -Id $oldPid -Force
        $oldProcess.WaitForExit()
      }
    } catch {
      # ignore stale pid entries
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }

  Write-Info "Starting cloudflared tunnel..."
  $process = Start-Process `
    -FilePath "cloudflared.exe" `
    -ArgumentList @("tunnel", "--no-autoupdate", "--url", $DownloaderUrl) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

  $deadline = (Get-Date).AddSeconds(35)
  $tunnelUrl = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    $combined = ""
    if (Test-Path -LiteralPath $stdoutLog) {
      $combined += (Get-Content -LiteralPath $stdoutLog -Raw -ErrorAction SilentlyContinue)
    }
    if (Test-Path -LiteralPath $stderrLog) {
      $combined += (Get-Content -LiteralPath $stderrLog -Raw -ErrorAction SilentlyContinue)
    }
    if ($combined) {
      if ($combined -match "https://[a-z0-9-]+\.trycloudflare\.com") {
        $tunnelUrl = $Matches[0]
        break
      }
    }
    if ($process.HasExited) {
      break
    }
  }

  if (-not $tunnelUrl) {
    throw "Failed to obtain trycloudflare URL. Check logs: $stdoutLog and $stderrLog"
  }

  Write-Info "Tunnel URL: $tunnelUrl"
  Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII
  return @{
    Url = $tunnelUrl
    Pid = $process.Id
    PidFile = $pidFile
    OutLog = $stdoutLog
    ErrLog = $stderrLog
  }
}

function Set-DownloaderApiUrl {
  param(
    [string]$WranglerPath,
    [string]$TunnelUrl
  )

  $raw = Get-Content -LiteralPath $WranglerPath -Raw
  $pattern = '"DOWNLOADER_API_URL"\s*:\s*"[^"]*"'
  $replacement = "`"DOWNLOADER_API_URL`": `"$TunnelUrl`""
  $updated = [Regex]::Replace($raw, $pattern, $replacement)
  if ($updated -eq $raw) {
    throw "Failed to update DOWNLOADER_API_URL in $WranglerPath"
  }
  Set-Content -LiteralPath $WranglerPath -Value $updated -Encoding UTF8
  Write-Info "Updated wrangler DOWNLOADER_API_URL to $TunnelUrl"
}

function Deploy-Worker {
  param([string]$WorkerDir)
  Write-Info "Deploying worker..."
  Push-Location $WorkerDir
  try {
    & npm.cmd run deploy
    if ($LASTEXITCODE -ne 0) {
      throw "Worker deploy failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Test-EndToEnd {
  param([string]$WorkerBase)
  Write-Info "Running health smoke test..."
  $health = Invoke-RestMethod -Method Get -Uri "$WorkerBase/api/health"
  if (-not $health.ok) {
    throw "Worker health check failed."
  }
  Write-Info "Worker health OK."
}

try {
  $repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
  $infraDir = Resolve-Path $PSScriptRoot
  $workerDir = Join-Path $repoRoot "worker"
  $wranglerPath = Join-Path $workerDir "wrangler.jsonc"
  $workerBase = "https://sounddrop.biramentv.workers.dev"

  Require-Command -Name "docker"
  Require-Command -Name "cloudflared.exe"
  Require-Command -Name "npm.cmd"

  Push-Location $infraDir
  try {
    Start-Downloader -InfraDir $infraDir
  } finally {
    Pop-Location
  }

  $tunnel = Start-TryCloudflare -RepoRoot $repoRoot -DownloaderUrl "http://localhost:8081"
  Set-DownloaderApiUrl -WranglerPath $wranglerPath -TunnelUrl $tunnel.Url
  Deploy-Worker -WorkerDir $workerDir
  Test-EndToEnd -WorkerBase $workerBase

  Write-Info "DONE"
  Write-Info "Tunnel PID: $($tunnel.Pid)"
  Write-Info "PID file: $($tunnel.PidFile)"
  Write-Info "Tunnel URL: $($tunnel.Url)"
  Write-Info "Out log: $($tunnel.OutLog)"
  Write-Info "Err log: $($tunnel.ErrLog)"
  Write-Info "Worker URL: $workerBase"
} catch {
  Write-Info "ERROR: $($_.Exception.Message)"
  if ($_.ScriptStackTrace) {
    Write-Info $_.ScriptStackTrace
  }
  exit 1
}

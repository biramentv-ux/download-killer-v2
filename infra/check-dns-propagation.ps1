param(
  [string]$Domain = "dyrakarmy.online",
  [string[]]$Resolvers = @("1.1.1.1", "8.8.8.8", "9.9.9.9"),
  [string[]]$ExpectedNameServers = @("courtney.ns.cloudflare.com", "dax.ns.cloudflare.com"),
  [string]$WorkerPublicUrl = "https://sounddrop.biramentv.workers.dev"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-Resolver {
  param(
    [string]$Name,
    [string]$Resolver
  )

  $result = [ordered]@{
    resolver = $Resolver
    domain = $Name
    ns_ok = $false
    a_ok = $false
    ns = @()
    a = @()
    error = $null
  }

  try {
    $nsRows = Resolve-DnsName -Name $Name -Type NS -Server $Resolver -DnsOnly -ErrorAction Stop
    $result.ns = @($nsRows | ForEach-Object { $_.NameHost } | Where-Object { $_ } | Sort-Object -Unique)
    if ($result.ns.Count -gt 0) {
      $result.ns_ok = $true
    }
  } catch {
    $result.error = "NS: $($_.Exception.Message)"
  }

  try {
    $aRows = Resolve-DnsName -Name $Name -Type A -Server $Resolver -DnsOnly -ErrorAction Stop
    $result.a = @(
      $aRows |
      ForEach-Object {
        if ($_.PSObject.Properties.Name -contains "IPAddress") { $_.IPAddress }
        elseif ($_.PSObject.Properties.Name -contains "IP4Address") { $_.IP4Address }
      } |
      Where-Object { $_ } |
      Sort-Object -Unique
    )
    if ($result.a.Count -gt 0) {
      $result.a_ok = $true
    }
  } catch {
    if ($result.error) {
      $result.error += " | A: $($_.Exception.Message)"
    } else {
      $result.error = "A: $($_.Exception.Message)"
    }
  }

  [pscustomobject]$result
}

function Get-CloudflareZoneStatus {
  param(
    [string]$ZoneName
  )

  try {
    $rawTokenJson = npx.cmd wrangler auth token --json 2>$null | Out-String
    if (-not $rawTokenJson) {
      return $null
    }
    $tokenObj = $rawTokenJson | ConvertFrom-Json
    $token = [string]$tokenObj.token
    if (-not $token) {
      return $null
    }

    $uri = "https://api.cloudflare.com/client/v4/zones?name=$([uri]::EscapeDataString($ZoneName))&per_page=1"
    $resp = Invoke-RestMethod -Method Get -Uri $uri -Headers @{ Authorization = "Bearer $token" } -ErrorAction Stop
    $zone = @($resp.result)[0]
    if (-not $zone) {
      return $null
    }

    return [pscustomobject]@{
      id = [string]$zone.id
      name = [string]$zone.name
      status = [string]$zone.status
      activated_on = [string]$zone.activated_on
      name_servers = @($zone.name_servers)
    }
  } catch {
    return [pscustomobject]@{
      error = "Cloudflare API check failed: $($_.Exception.Message)"
    }
  }
}

function Test-WorkerEndpoint {
  param(
    [string]$BaseUrl
  )

  $healthUrl = "$BaseUrl/api/health"
  try {
    $resp = Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 20 -ErrorAction Stop
    return [pscustomobject]@{
      ok = $true
      url = $healthUrl
      status = "ok"
      payload = $resp
    }
  } catch {
    return [pscustomobject]@{
      ok = $false
      url = $healthUrl
      status = "failed"
      error = $_.Exception.Message
    }
  }
}

$rootReport = @()
foreach ($resolver in $Resolvers) {
  $rootReport += Test-Resolver -Name $Domain -Resolver $resolver
}

$wwwDomain = "www.$Domain"
$wwwReport = @()
foreach ($resolver in $Resolvers) {
  $wwwReport += Test-Resolver -Name $wwwDomain -Resolver $resolver
}

$expectedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($ns in $ExpectedNameServers) {
  $clean = $ns.Trim().TrimEnd('.')
  if ($clean) { [void]$expectedSet.Add($clean) }
}

$seenSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $rootReport) {
  foreach ($ns in @($entry.ns)) {
    $clean = [string]$ns
    if ($clean) { [void]$seenSet.Add($clean.Trim().TrimEnd('.')) }
  }
}

$missingExpected = @()
foreach ($ns in $expectedSet) {
  if (-not $seenSet.Contains($ns)) {
    $missingExpected += $ns
  }
}

$cloudflareZone = Get-CloudflareZoneStatus -ZoneName $Domain
$domainActive = ($cloudflareZone -and $cloudflareZone.status -eq "active")
$liveBaseUrl = if ($domainActive) { "https://$Domain" } else { $WorkerPublicUrl }
$workerHealth = Test-WorkerEndpoint -BaseUrl $liveBaseUrl

$advice = @()
if (-not $domainActive) {
  $advice += "Cloudflare zone is not active yet. Set registrar nameservers to: $($ExpectedNameServers -join ', ')."
}
if ($missingExpected.Count -gt 0) {
  $advice += "Nameserver propagation incomplete. Missing expected NS on tested resolvers: $($missingExpected -join ', ')."
}
if ($workerHealth.ok -eq $false) {
  $advice += "Worker health check failed on $liveBaseUrl. Verify deploy/routes."
}
if ($advice.Count -eq 0) {
  $advice += "DNS and Worker health look good."
}

$obj = [ordered]@{
  checked_at_utc = (Get-Date).ToUniversalTime().ToString("o")
  domain = $Domain
  expected_nameservers = $ExpectedNameServers
  cloudflare_zone = $cloudflareZone
  resolver_checks = [ordered]@{
    root = $rootReport
    www = $wwwReport
  }
  dns_expected_ns_missing = $missingExpected
  active_base_url = $liveBaseUrl
  worker_health = $workerHealth
  advice = $advice
}

$obj | ConvertTo-Json -Depth 12

param(
  [string]$ZoneId = $env:CLOUDFLARE_ZONE_ID,
  [string]$ApiToken = $env:CLOUDFLARE_API_TOKEN,
  [string]$WranglerConfigPath = "$env:APPDATA\xdg.config\.wrangler\config\default.toml"
)

$ErrorActionPreference = "Stop"

if (-not $ZoneId) {
  $ZoneId = "ca027447752aef4afd9de29aeeb6f613"
}

if (-not $ApiToken -and (Test-Path -LiteralPath $WranglerConfigPath)) {
  $config = Get-Content -LiteralPath $WranglerConfigPath -Raw
  $match = [regex]::Match($config, '(?m)^\s*(oauth_token|api_token)\s*=\s*"([^"]+)"')
  if ($match.Success) {
    $ApiToken = $match.Groups[2].Value
  }
}

if (-not $ApiToken) {
  throw "Missing Cloudflare API token. Set CLOUDFLARE_API_TOKEN or log in with wrangler."
}

$headers = @{
  Authorization = "Bearer $ApiToken"
  "Content-Type" = "application/json"
}

$apiBase = "https://api.cloudflare.com/client/v4/zones/$ZoneId"
$phase = "http_request_firewall_custom"

$sqlInjectionExpression = @'
((http.request.uri.path eq "/api/search" or http.request.uri.path contains "/api/job/") and (lower(http.request.uri.query) contains "union select" or lower(http.request.uri.query) contains "union%20select" or lower(http.request.uri.query) contains "information_schema" or lower(http.request.uri.query) contains " or 1=1" or lower(http.request.uri.query) contains "%20or%201=1" or lower(http.request.uri.query) contains "sleep(" or lower(http.request.uri.query) contains "benchmark(" or lower(http.request.uri.query) contains "' or '" or lower(http.request.uri.query) contains "%27%20or%20%27"))
'@.Trim()

$pathTraversalExpression = @'
(lower(http.request.uri.path) contains "../" or lower(http.request.uri.path) contains "..%2f" or lower(http.request.uri.path) contains "%2e%2e" or lower(http.request.uri.path) contains "%252e%252e" or lower(http.request.uri.query) contains "../" or lower(http.request.uri.query) contains "..%2f" or lower(http.request.uri.query) contains "%2e%2e" or lower(http.request.uri.query) contains "%252e%252e")
'@.Trim()

$scrapingUaExpression = @'
((http.request.uri.path contains "/api/") and (lower(http.user_agent) contains "python-requests" or lower(http.user_agent) contains "scrapy" or lower(http.user_agent) contains "go-http-client" or lower(http.user_agent) contains "java/" or lower(http.user_agent) contains "okhttp" or lower(http.user_agent) contains "libwww-perl" or lower(http.user_agent) contains "httpclient" or lower(http.user_agent) contains "aiohttp" or lower(http.user_agent) contains "node-fetch"))
'@.Trim()

$dyrakArmyRules = @(
  @{
    description = "DyrakArmy: block SQLi probes on API"
    action = "block"
    expression = $sqlInjectionExpression
  },
  @{
    description = "DyrakArmy: block path traversal probes"
    action = "block"
    expression = $pathTraversalExpression
  },
  @{
    description = "DyrakArmy: block common scraping user agents on API"
    action = "block"
    expression = $scrapingUaExpression
  }
)

function Invoke-CfApi {
  param(
    [ValidateSet("GET", "POST", "PUT")]
    [string]$Method,
    [string]$Uri,
    [object]$Body = $null,
    [switch]$AllowNotFound
  )

  try {
    if ($null -ne $Body) {
      $json = $Body | ConvertTo-Json -Depth 20
      return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -Body $json
    }
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers
  } catch {
    $response = $_.Exception.Response
    if ($AllowNotFound -and $response -and [int]$response.StatusCode -eq 404) {
      return $null
    }
    throw
  }
}

$entrypointUri = "$apiBase/rulesets/phases/$phase/entrypoint"
$entrypoint = Invoke-CfApi -Method GET -Uri $entrypointUri -AllowNotFound

if ($null -eq $entrypoint) {
  $body = @{
    name = "DyrakArmy WAF"
    description = "DyrakArmy custom API protection"
    kind = "zone"
    phase = $phase
    rules = $dyrakArmyRules
  }
  $created = Invoke-CfApi -Method POST -Uri "$apiBase/rulesets" -Body $body
  Write-Output "created=$($created.result.id)"
  Write-Output "rules=$($dyrakArmyRules.Count)"
  exit 0
}

$existingRules = @()
if ($entrypoint.result.rules) {
  $existingRules = @($entrypoint.result.rules | Where-Object {
    -not ([string]$_.description).StartsWith("DyrakArmy:")
  })
}

$mergedRules = @($existingRules + $dyrakArmyRules)
$updateBody = @{
  description = $entrypoint.result.description
  rules = $mergedRules
}

$updated = Invoke-CfApi -Method PUT -Uri $entrypointUri -Body $updateBody
Write-Output "updated=$($updated.result.id)"
Write-Output "rules=$($updated.result.rules.Count)"

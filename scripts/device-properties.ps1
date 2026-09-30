# Prints every property Windows stores for one device (the "Details" tab in Device Manager) as JSON.
# The instance ID arrives in $env:PORTER_DEVICE_ID so it is never parsed as PowerShell code.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$props = Get-PnpDeviceProperty -InstanceId $env:PORTER_DEVICE_ID

$out = foreach ($p in $props) {
  $d = $p.Data
  if ($null -eq $d -or ($d -is [string] -and $d -eq '')) { continue }

  if ($d -is [byte[]]) {
    $value = (($d | Select-Object -First 64 | ForEach-Object { $_.ToString('X2') }) -join ' ') + $(if ($d.Length -gt 64) { ' …' } else { '' })
  } elseif ($d -is [array]) {
    $value = ($d | ForEach-Object { [string]$_ }) -join "`n"
  } elseif ($d -is [datetime]) {
    $value = $d.ToString('yyyy-MM-dd HH:mm:ss')
  } else {
    $value = [string]$d
  }

  [pscustomobject]@{ Key = $p.KeyName; Type = [string]$p.Type; Value = $value }
}

ConvertTo-Json -InputObject @($out) -Depth 3 -Compress

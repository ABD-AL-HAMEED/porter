# Prints one line per Plug-and-Play change (any device class: USB, monitors, Bluetooth, ...).
# Exits on its own if the Electron process disappears, so it can never be orphaned.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$parentPid = [int]$env:PORTER_PARENT_PID

Register-CimIndicationEvent -ClassName Win32_DeviceChangeEvent -SourceIdentifier PorterPnp | Out-Null
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

while ($true) {
  $evt = Wait-Event -SourceIdentifier PorterPnp -Timeout 5
  if ($evt) {
    [Console]::Out.WriteLine('change:' + $evt.SourceEventArgs.NewEvent.EventType)
    [Console]::Out.Flush()
    Remove-Event -EventIdentifier $evt.EventIdentifier
  }
  if ($parentPid -gt 0 -and -not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
}

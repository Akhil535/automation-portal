# Removes the start-up task and stops the running portal.
Unregister-ScheduledTask -TaskName 'DoH Circular Portal' -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -like '*use-system-ca*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host 'Start-up task removed and portal stopped.'

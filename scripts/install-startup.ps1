# Registers "DoH Circular Portal" in Windows Task Scheduler: starts the portal (and its nightly
# scheduler) hidden when you log on to Windows, restarting it if it stops. No admin rights needed.
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot 'start-portal-hidden.vbs'
New-Item -ItemType Directory -Force (Join-Path $app 'logs') | Out-Null
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'DoH Circular Portal' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'DoH Abu Dhabi circular monitoring portal (nightly checks, Legal Register updates, e-mail)' -Force | Out-Null
Start-ScheduledTask -TaskName 'DoH Circular Portal'
Write-Host "Installed. The portal starts at every log-on and is running now: http://localhost:8080"

# Registers "DoH Portal Public Link" in Windows Task Scheduler: one minute after you log on (the portal starts first),
# the public link starts hidden - Cloudflare tunnel + the start page https://akhil535.github.io/automation-portal.
# It restarts if it stops. No admin rights needed. Remove with: Unregister-ScheduledTask -TaskName 'DoH Portal Public Link'
param([switch]$StartNow)
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot 'start-public-link-hidden.vbs'
New-Item -ItemType Directory -Force (Join-Path $app 'logs') | Out-Null
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT1M'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'DoH Portal Public Link' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Public link to the Compliance Portal: Cloudflare quick tunnel + GitHub Pages start page (akhil535.github.io/automation-portal)' -Force | Out-Null
Write-Host "Installed: the public link starts one minute after every log-on."
if ($StartNow) { Start-ScheduledTask -TaskName 'DoH Portal Public Link'; Write-Host "Started now - https://akhil535.github.io/automation-portal is updated within a minute." }

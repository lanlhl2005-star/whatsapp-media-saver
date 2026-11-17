# Register Windows Task Scheduler jobs for the WhatsApp media saver.
# Run once in PowerShell (as the user who will stay logged in on the always-on PC):
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\scripts\register-tasks.ps1
#
# Creates:
#   1) WhatsAppMediaSaver-Daemon  — At log on, restart on failure
#   2) WhatsAppMediaSaver-Health  — every 10 minutes

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
$DaemonCmd = Join-Path $AppRoot 'scripts\run-daemon.cmd'
$HealthCmd = Join-Path $AppRoot 'scripts\healthcheck.cmd'

if (-not (Test-Path $DaemonCmd)) { throw "Missing $DaemonCmd" }
if (-not (Test-Path $HealthCmd)) { throw "Missing $HealthCmd" }

$daemonName = 'WhatsAppMediaSaver-Daemon'
$healthName = 'WhatsAppMediaSaver-Health'

# Remove existing (idempotent re-register)
foreach ($n in @($daemonName, $healthName)) {
  if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $n -Confirm:$false
  }
}

# --- Daemon: at log on, keep alive ---
$daemonAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$DaemonCmd`"" -WorkingDirectory $AppRoot
$daemonTrigger = New-ScheduledTaskTrigger -AtLogOn
$daemonSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$daemonPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $daemonName -Action $daemonAction -Trigger $daemonTrigger `
  -Settings $daemonSettings -Principal $daemonPrincipal -Description 'Baileys linked-device WhatsApp media saver daemon' | Out-Null

# --- Health: every 10 minutes ---
$healthAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$HealthCmd`"" -WorkingDirectory $AppRoot
$healthTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration ([TimeSpan]::MaxValue)
$healthSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName $healthName -Action $healthAction -Trigger $healthTrigger `
  -Settings $healthSettings -Principal $daemonPrincipal -Description '10-minute health check for WhatsApp media saver' | Out-Null

Write-Host "Registered scheduled tasks:"
Write-Host "  - $daemonName (At log on)"
Write-Host "  - $healthName (every 10 minutes)"
Write-Host ""
Write-Host "Start the daemon now with:"
Write-Host "  Start-ScheduledTask -TaskName $daemonName"
Write-Host "Or: npm start"

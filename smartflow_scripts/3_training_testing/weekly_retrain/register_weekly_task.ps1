# Registers the Scheduled Task "SmartFlow weekly retrain": every Sunday at 22:00,
# the batch retrain and test agreed with the adviser (weekly_retrain.py).
#
# Run once, from this folder:
#   powershell -ExecutionPolicy Bypass -File register_weekly_task.ps1
# Run it now instead of waiting for Sunday:
#   schtasks /Run /TN "SmartFlow weekly retrain"
# Remove it:
#   Unregister-ScheduledTask -TaskName 'SmartFlow weekly retrain' -Confirm:$false
#
# Settings:
#   - StartWhenAvailable: if the PC is off or asleep at 22:00 on Sunday, the batch
#     runs as soon as it is back on, instead of skipping the week.
#   - 12-hour limit: a full batch takes about two to three hours.
#   - IgnoreNew: a second start while one is running does nothing (the batch also
#     holds a database lock, so two can never overlap).
#   - It runs as the logged-in user, like "SmartFlow congestion refresh", so it
#     needs that user signed in (the screen may be locked).
#
# If the time changes here, change RETRAIN_SCHEDULE in
# Back-End/src/services/retrain-schedule.ts too: the Data Management page
# shows the next run from it.
$name = 'SmartFlow weekly retrain'
$launcher = Join-Path $PSScriptRoot 'run_weekly_retrain.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"') `
    -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Sunday -At '22:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 12) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force `
    -Description 'SmartFlow NLEX: weekly batch retrain and test of the forecasting models (weekly_retrain.py). Retrains each model group whose data changed, tests it, and keeps last week''s models if the new ones fail.' | Out-Null

Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Select-Object TaskName, NextRunTime | Format-List

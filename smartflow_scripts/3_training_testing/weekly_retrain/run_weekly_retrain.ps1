# Runs weekly_retrain.py with no visible window.
#
# The Scheduled Task "SmartFlow weekly retrain" (see register_weekly_task.ps1)
# calls this every Sunday at 22:00. weekly_retrain.py writes its own log under
# smartflow_scripts/_work/logs/weekly_retrain/ and records each run in
# gold.ml_batch_runs. Anything printed before that log opens (a missing Python,
# a broken import) lands in launcher_out.txt / launcher_err.txt beside it.
#
# No retries here: the batch retries each trainer itself, and a group it could
# not retrain keeps last week's models and is tried again the next Sunday.
$py = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\python.exe'
if (-not (Test-Path $py)) { $py = 'python' }

$logs = Join-Path $PSScriptRoot '..\..\_work\logs\weekly_retrain'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$script = Join-Path $PSScriptRoot 'weekly_retrain.py'
$p = Start-Process -FilePath $py -ArgumentList @('-u', ('"' + $script + '"'), '--scheduled') `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $logs 'launcher_out.txt') `
    -RedirectStandardError (Join-Path $logs 'launcher_err.txt')
exit $p.ExitCode

# Runs fetch_weather_open_meteo.py --write with no visible window, for the Scheduled Task "SmartFlow weather hourly".
#
# Same reasons as the congestion refresh's launcher (All_Scripts/Predictive_Modeling/refresh_congestion_hidden.ps1):
# an interactive task flashes a console every hour, and Task Scheduler does not retry a process that started and
# exited non-zero, so the retry lives here. A run takes a few seconds; the failures seen on this laptop's hotspot
# are transient (connection reset, host name not resolved), so three tries two minutes apart cover them. A lost
# hour is not lost data: the next run looks back 120 days and fills it.
$script = Join-Path $PSScriptRoot 'fetch_weather_open_meteo.py'
$log = Join-Path $PSScriptRoot 'fetch_weather.log'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent    # smartflow_scripts

# The bare "python" is a Store app alias that only resolves in some shells (see refresh_congestion.bat).
$py = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\python.exe'
if (-not (Test-Path $py)) { $py = 'python' }

# Keep the log short: the last ~2,000 lines are plenty to troubleshoot.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 500KB)) {
    Get-Content $log -Tail 2000 | Set-Content -Path $log -Encoding utf8
}

$attempts = 3
$code = 1
for ($i = 1; $i -le $attempts; $i++) {
    $p = Start-Process -FilePath $py -ArgumentList @('-u', ('"' + $script + '"'), '--write') -WorkingDirectory $root `
        -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput "$log.out" -RedirectStandardError "$log.err"
    $code = $p.ExitCode
    Get-Content "$log.out", "$log.err" -ErrorAction SilentlyContinue | Add-Content -Path $log
    if ($code -eq 0) { break }
    Add-Content -Path $log -Value "launcher: attempt $i of $attempts failed with exit code $code"
    if ($i -lt $attempts) { Start-Sleep -Seconds 120 }
}
Remove-Item "$log.out", "$log.err" -ErrorAction SilentlyContinue
if ($code -ne 0) { Add-Content -Path $log -Value "launcher: all $attempts attempts failed; the next hour's run will fill this hour" }
exit $code

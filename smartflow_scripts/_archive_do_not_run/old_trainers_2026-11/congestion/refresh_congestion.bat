@echo off
REM ---------------------------------------------------------------------------
REM Hourly refresh for the Predictive Congestion State Map.
REM
REM The card stamps its forecast with the last complete hour of Waze ingestion
REM and shows "expired" once that is more than twelve hours behind the clock,
REM because a 12-hour-ahead forecast whose window has already passed is not a
REM forecast. Keeping it green means re-running the model regularly.
REM
REM --fast skips SARIMAX, which is about 90% of the runtime and has never been
REM accepted. A refresh takes roughly two minutes instead of twenty-five.
REM
REM Registered as the Scheduled Task "SmartFlow congestion refresh".
REM   List it:    schtasks /Query /TN "SmartFlow congestion refresh"
REM   Run it now: schtasks /Run   /TN "SmartFlow congestion refresh"
REM   Remove it:  schtasks /Delete /TN "SmartFlow congestion refresh" /F
REM
REM Credentials come from Back-End\.env, so that file has to stay in place.
REM ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

REM Keep the last run's output next to the script for troubleshooting.
set "LOG=%~dp0refresh_congestion.log"

echo ============================================================ >> "%LOG%"
echo Run started %DATE% %TIME% >> "%LOG%"

REM The bare "python" is a Store app alias that only resolves in some shells.
REM Prefer the versioned alias the user's shell actually runs; fall back to
REM whatever "python" resolves to if that ever moves.
set "PY=%LOCALAPPDATA%\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -u train_congestion_horizon.py --fast >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

echo Run finished %DATE% %TIME% with exit code %RC% >> "%LOG%"
exit /b %RC%

# Runs refresh_congestion.bat with no visible window.
#
# The Scheduled Task "SmartFlow congestion refresh" calls this rather than the
# .bat directly. Run as a normal interactive task, the .bat opened a console
# window on the desktop every hour; one was closed by hand mid-run, which ended
# it with STATUS_CONTROL_C_EXIT before it could publish. A background logon
# type would avoid the window but needs a right this account does not have, so
# the window is simply never shown.
#
# RETRIES. The publish reaches RDS over whatever network the laptop is on, and
# a mobile hotspot drops often enough to matter: two of the first three hourly
# runs died before reaching the database -- one "SSL SYSCALL error: Connection
# reset by peer", one "could not translate host name" -- and each lost hour
# leaves the congestion map an hour closer to expiring.
#
# The task's own "restart on failure" setting does NOT cover this. Task
# Scheduler restarts a task that fails to LAUNCH; a task whose process starts
# and exits non-zero is, to the scheduler, a task that ran. So the retry has to
# live here, where the exit code is actually visible.
#
# Three attempts, three minutes apart: a run takes ~80 s, so the worst case is
# about nine minutes and still lands inside the hour and inside the task's
# 30-minute ExecutionTimeLimit. The failures seen are transient connectivity,
# which is exactly what a short wait fixes; a genuine breakage (bad
# credentials, a missing table) fails all three the same way and surfaces in
# refresh_congestion.log rather than being silently retried forever.
$bat = Join-Path $PSScriptRoot 'refresh_congestion.bat'
$log = Join-Path $PSScriptRoot 'refresh_congestion.log'

$attempts = 3
$code = 1
for ($i = 1; $i -le $attempts; $i++) {
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $bat + '"')) -WindowStyle Hidden -Wait -PassThru
    $code = $p.ExitCode
    if ($code -eq 0) { break }
    Add-Content -Path $log -Value "launcher: attempt $i of $attempts failed with exit code $code"
    if ($i -lt $attempts) { Start-Sleep -Seconds 180 }
}
if ($code -ne 0) {
    Add-Content -Path $log -Value "launcher: all $attempts attempts failed; forecast not republished this hour"
}
exit $code

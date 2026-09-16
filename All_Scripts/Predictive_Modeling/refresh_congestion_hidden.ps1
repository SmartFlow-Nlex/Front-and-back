# Runs refresh_congestion.bat with no visible window.
#
# The Scheduled Task "SmartFlow congestion refresh" calls this rather than the
# .bat directly. Run as a normal interactive task, the .bat opened a console
# window on the desktop every hour; one was closed by hand mid-run, which ended
# it with STATUS_CONTROL_C_EXIT before it could publish. A background logon
# type would avoid the window but needs a right this account does not have, so
# the window is simply never shown.
$bat = Join-Path $PSScriptRoot 'refresh_congestion.bat'
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $bat + '"')) -WindowStyle Hidden -Wait -PassThru
exit $p.ExitCode

@echo off
title Telegram Bot - Status and Logs
cd /d "%~dp0"

echo ===================================================
echo             Telegram Bot Status
echo ===================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*m-automation-bot*' }; if ($procs) { Write-Host ' [STATUS] Bot is RUNNING (PID: ' ($procs.ProcessId -join ', ') ')' -ForegroundColor Green } else { Write-Host ' [STATUS] Bot is STOPPED' -ForegroundColor Red }"

echo.
echo ===================================================
echo             Recent Logs (Last 30 lines)
echo ===================================================
echo.

if not exist "runtime\bot.log" goto NO_LOG
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Path 'runtime\bot.log' -Tail 30"
goto END

:NO_LOG
echo [INFO] No log file found yet (runtime\bot.log).

:END
echo.
echo ===================================================
pause

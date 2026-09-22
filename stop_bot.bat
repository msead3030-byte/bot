@echo off
title Stop Telegram Bot
cd /d "%~dp0"

echo ===================================================
echo             Stopping Telegram Bot
echo ===================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$killed = 0; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*m-automation-bot*') -or ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*watchdog.bat*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }; if ($killed -gt 0) { Write-Host ' [SUCCESS] Telegram Bot and Watchdog stopped successfully.' -ForegroundColor Green } else { Write-Host ' [INFO] No running bot instances found.' -ForegroundColor Yellow }"

if not exist "runtime\bot.log" goto END
echo [%date% %time%] [INFO] Stopped by user via stop_bot.bat >> "runtime\bot.log"

:END
echo.
pause

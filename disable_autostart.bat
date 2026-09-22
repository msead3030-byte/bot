@echo off
title Disable Bot Auto-Start on Windows Boot
cd /d "%~dp0"
echo ===================================================
echo     Disable Telegram Bot Auto-Start
echo ===================================================
echo.
powershell -NoProfile -Command ^
  "$startupDir = [System.Environment]::GetFolderPath('Startup');" ^
  "$shortcutPath = Join-Path $startupDir 'TelegramBotHost.lnk';" ^
  "if (Test-Path $shortcutPath) { Remove-Item -Path $shortcutPath -Force; Write-Host ' [SUCCESS] Auto-start disabled. Shortcut removed.' -ForegroundColor Green } else { Write-Host ' [INFO] Auto-start shortcut was not found.' -ForegroundColor Yellow }"
echo.
pause

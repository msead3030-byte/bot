@echo off
title Enable Bot Auto-Start on Windows Boot
cd /d "%~dp0"
echo ===================================================
echo     Enable Telegram Bot Auto-Start (VPS Mode)
echo ===================================================
echo.
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$startupDir = [System.Environment]::GetFolderPath('Startup');" ^
  "$shortcutPath = Join-Path $startupDir 'TelegramBotHost.lnk';" ^
  "$vbsPath = Join-Path (Get-Location).Path 'start_bot_background.vbs';" ^
  "$sc = $ws.CreateShortcut($shortcutPath);" ^
  "$sc.TargetPath = $vbsPath;" ^
  "$sc.WorkingDirectory = (Get-Location).Path;" ^
  "$sc.Description = 'Start Telegram Bot automatically in background on boot';" ^
  "$sc.Save();" ^
  "Write-Host ' [SUCCESS] Auto-start configured! The bot will now run automatically on Windows startup.' -ForegroundColor Green"
echo.
echo Shortcut added to Windows Startup folder.
echo.
pause

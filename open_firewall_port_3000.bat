@echo off
title Open Firewall Port 3000 for SMS Webhook
echo ===================================================
echo    Opening Port 3000 for SMS Webhook
echo ===================================================
echo.

NET SESSION >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Please run this file as Administrator!
    echo Right-click on the file and choose Run as administrator
    pause
    exit /b 1
)

netsh advfirewall firewall add rule name="Telegram Bot SMS Webhook Port 3000" dir=in action=allow protocol=TCP localport=3000
if %ERRORLEVEL% EQU 0 (
    echo.
    echo [SUCCESS] Port 3000 opened successfully!
    echo The phone app can now send SMS data to this computer.
) else (
    echo [INFO] Rule may already exist or was updated.
)

echo.
echo Your local IP for the phone app:
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr "IPv4"') do (
    echo   http://%%i:3000/api/sms/webhook
)
echo.
pause

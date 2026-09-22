@echo off
cd /d "%~dp0.."

if not exist "runtime" mkdir "runtime"

echo [%date% %time%] === Bot Host Watchdog Started === >> "runtime\bot.log"

if not exist ".env" (
    echo [%date% %time%] [ERROR] .env file not found! >> "runtime\bot.log"
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] [ERROR] Node.js is not installed or not in PATH! >> "runtime\bot.log"
    exit /b 1
)

if not exist "node_modules\dotenv" (
    echo [%date% %time%] [INFO] Installing packages... >> "runtime\bot.log"
    call npm.cmd install >> "runtime\bot.log" 2>&1
)

:LOOP
echo [%date% %time%] [INFO] Starting Telegram Bot... >> "runtime\bot.log"
node bin/m-automation-bot.js >> "runtime\bot.log" 2>&1
echo [%date% %time%] [WARN] Bot stopped. Auto-restarting in 5s... >> "runtime\bot.log"
ping 127.0.0.1 -n 6 >nul
goto LOOP

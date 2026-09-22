@echo off
title Telegram Bot - Digital Market
cd /d "%~dp0"

echo ====================================================================
echo                   Starting Telegram Bot...
echo ====================================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

if not exist ".env" (
    echo [ERROR] .env file is missing!
    pause
    exit /b 1
)

if not exist "node_modules\dotenv" (
    echo [INFO] Installing required packages...
    call npm.cmd install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo [INFO] Telegram Bot is starting...
echo.
echo ====================================================================
echo  [IMPORTANT]:
echo  - Keep this window open while using the bot.
echo  - Bot username: @Digital1_market1_bot
echo ====================================================================
echo.

node bin/m-automation-bot.js

echo.
echo ====================================================================
echo [INFO] Process finished / Bot stopped.
echo ====================================================================
pause

@echo off
title Setup .env configuration
cd /d "%~dp0\.."
echo ===================================================
echo           Setup Environment (.env)
echo ===================================================
echo.

if exist ".env" (
    echo [INFO] .env file already exists!
    echo If you want to view or edit your keys, open the .env file in any text editor.
    pause
    exit /b 0
)

echo [INFO] Generating secure 64-char encryption key...
for /f "delims=" %%i in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 2^>nul') do set DATA_KEY=%%i

if "%DATA_KEY%"=="" (
    set DATA_KEY=e8f92a10c73b4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e
)

(
echo # Required Telegram Bot Settings
echo M_AUTOMATION_BOT_TOKEN=replace_with_your_bot_token_from_botfather
echo M_AUTOMATION_SUPER_ADMIN_IDS=replace_with_your_telegram_id
echo M_AUTOMATION_DATA_KEY=%DATA_KEY%
echo.
echo # Store branding
echo STORE_BRAND_NAME=Mohamed Payment Store
echo STORE_CURRENCY_CODE=EGP
echo STORE_CURRENCY_NAME=Egyptian pound
echo.
echo # Database local path
echo M_AUTOMATION_DB_PATH=runtime/store.db
echo.
echo # Manual topups
echo MANUAL_TOPUPS_ENABLED=true
echo MANUAL_WALLET_RECEIVER=01000000000
echo MANUAL_WALLET_INSTRUCTIONS=???? ????? ?????? ??????? ??? ??? ??????? ?? ????? ???? ??????? ???.
echo MANUAL_BINANCE_RECEIVER=
echo MANUAL_BINANCE_INSTRUCTIONS=
echo.
echo # Admin contact
echo ADMIN_CONTACT_URL=
echo ADMIN_USERNAME=your_admin_username
echo.
echo # Mandatory channels ^(optional - leave empty if not used^)
echo REQUIRED_CHANNEL_1=
echo REQUIRED_CHANNEL_1_LINK=
echo REQUIRED_CHANNEL_2=
echo REQUIRED_CHANNEL_2_LINK=
echo REQUIRED_GROUP_1=
echo REQUIRED_GROUP_1_LINK=
echo REQUIRED_GROUP_2=
echo REQUIRED_GROUP_2_LINK=
) > .env

echo [SUCCESS] .env file created successfully!
echo.
echo Please open the '.env' file now and enter your M_AUTOMATION_BOT_TOKEN and M_AUTOMATION_SUPER_ADMIN_IDS.
echo.
pause

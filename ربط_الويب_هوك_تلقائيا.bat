@echo off
chcp 65001 >nul
title ربط الويب هوك لتأكيد الدفع التلقائي - SMS Gateway
cd /d "%~dp0"

echo ====================================================================
echo        ربط وتفعيل الويب هوك السحابي مع سيرفر البوت تلقائياً
echo ====================================================================
echo.
echo يرجى إدخال رابط السيرفر العام أو رابط النفق الخاص بك (HTTPS):
echo (مثال: https://my-bot.up.railway.app أو رابط Cloudflare / Ngrok)
echo.
set /p SERVER_URL="ضع الرابط هنا واضغط Enter: "

if "%SERVER_URL%"=="" (
    echo.
    echo [خطأ] لم يتم إدخال أي رابط!
    pause
    exit /b 1
)

echo.
node bin/sms-gateway.js register %SERVER_URL%

echo.
echo ====================================================================
pause


@echo off
title Push to GitHub
cd /d "%~dp0"
echo ===================================================
echo           Pushing to GitHub Repository
echo           msead3030-byte/bot
echo ===================================================
echo.
git push -u origin main
echo.
if %ERRORLEVEL% equ 0 (
    echo [SUCCESS] Push completed successfully!
) else (
    echo [ERROR] Push failed. If authentication was requested, please check your browser.
)
echo.
pause

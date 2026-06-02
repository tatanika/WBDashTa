@echo off
title WB Dashboard
chcp 65001 >nul
echo Запуск WB Dashboard...
set PATH=C:\Program Files\nodejs;%PATH%
cd /d "%~dp0"

:: Создаём config.js из шаблона если его нет
if not exist config.js (
  echo Создаём config.js из шаблона...
  copy config.example.js config.js >nul
)

:: Устанавливаем зависимости если нет node_modules
if not exist node_modules (
  echo Устанавливаем зависимости (первый запуск)...
  npm install
)

:: Освобождаем порт 3000 если занят
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 "') do (
  taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo Открой браузер: http://localhost:3000
node server.js
pause

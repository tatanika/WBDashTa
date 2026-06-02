@echo off
echo Запуск Яндекс Браузера с remote debugging...
echo.
echo После запуска можно проверить позиции товаров на WB!
echo.
start "" "C:\Program Files\Yandex\YandexBrowser\Application\browser.exe" --remote-debugging-port=9222
echo ✅ Браузер запущен с портом 9222
echo.
echo Запуск сервера...
cd /d %~dp0
node server.js

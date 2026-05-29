@echo off
chcp 65001 >nul
title Deadline Tracker
cd /d "%~dp0"

echo ========================================
echo   Deadline Tracker - запуск
echo ========================================
echo.

if not exist ".env" (
  echo [!] Файл .env не найден.
  echo     Создай его рядом с этим start.bat по образцу .env.example
  echo     и впиши BOT_TOKEN и CHAT_ID.
  echo.
  pause
  exit /b 1
)

echo [1/2] Проверяю и ставлю зависимости...
python -m pip install -r backend\requirements.txt ^
  --trusted-host pypi.org ^
  --trusted-host files.pythonhosted.org ^
  --trusted-host pypi.python.org ^
  --disable-pip-version-check -q
if errorlevel 1 (
  echo [!] Не удалось установить зависимости. Смотри ошибку выше.
  pause
  exit /b 1
)

echo [2/2] Запускаю сервер и бота...
echo.
echo  Веб-интерфейс:  http://localhost:8000
echo  Останов:        Ctrl+C  или закрой это окно
echo.
cd backend
python -m uvicorn main:app --port 8000

pause

# Deadline Tracker

Трекер дедлайнов: веб-интерфейс + Telegram-бот.

## Быстрый старт

```bash
cd backend
pip install -r requirements.txt

# Создай .env (скопируй из .env.example и заполни)
cp ../.env.example ../.env

python -m uvicorn main:app --reload --port 8000
```

Открой http://localhost:8000

## Получить CHAT_ID

Напиши боту @userinfobot в Telegram — он пришлёт твой ID.

## Telegram-бот команды

| Команда | Описание |
|---|---|
| /start | Приветствие и список команд |
| /list | Все дедлайны с countdown |
| /add | Добавить дедлайн (диалог) |
| /delete <id> | Удалить дедлайн |
| /today | Дедлайны на ближайшие 48 часов |
| /cancel | Отменить текущий диалог |

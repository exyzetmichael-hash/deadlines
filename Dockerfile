FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY frontend/ ./frontend/

RUN mkdir -p /data

WORKDIR /app/backend

ENV DATA_DIR=/data
ENV PORT=8000

EXPOSE 8000

# Слушаем порт из $PORT (Koyeb задаёт его сам), fallback на 8000
CMD ["sh", "-c", "python -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]

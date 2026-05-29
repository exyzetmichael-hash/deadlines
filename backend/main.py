import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends, HTTPException, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from dotenv import load_dotenv
from telegram import Update

import crud
import models
from database import engine, SessionLocal, get_db
from schemas import DeadlineCreate, DeadlineUpdate, DeadlineOut, ReminderCreate, ReminderOut
from scheduler import init_scheduler
from bot import build_application, init_bot, BOT_COMMANDS

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
CHAT_ID = int(os.getenv("CHAT_ID", "0"))
# WEBHOOK_URL можно задать явно; если не задан — используем RENDER_EXTERNAL_URL,
# которую Render выставляет автоматически для web-сервисов.
WEBHOOK_URL = (
    os.getenv("WEBHOOK_URL", "").strip()
    or os.getenv("RENDER_EXTERNAL_URL", "").strip()
)
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "").strip()

models.Base.metadata.create_all(bind=engine)


def _ensure_schema():
    """Лёгкая миграция: добавляет новые колонки в уже существующую БД."""
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    cols = [c["name"] for c in insp.get_columns("deadlines")]
    if "archived" not in cols:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE deadlines ADD COLUMN archived BOOLEAN DEFAULT FALSE NOT NULL"))
        logger.info("Migration: added deadlines.archived")


_ensure_schema()

bot_app = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global bot_app
    if BOT_TOKEN and CHAT_ID:
        init_bot(SessionLocal, CHAT_ID)
        bot_app = build_application(BOT_TOKEN)
        await bot_app.initialize()
        await bot_app.start()
        await bot_app.bot.set_my_commands(BOT_COMMANDS)
        if WEBHOOK_URL:
            hook = WEBHOOK_URL.rstrip("/") + "/telegram"
            await bot_app.bot.set_webhook(
                url=hook,
                secret_token=WEBHOOK_SECRET or None,
                allowed_updates=Update.ALL_TYPES,
                drop_pending_updates=True,
            )
            logger.info(f"Bot started in WEBHOOK mode: {hook}")
        else:
            # На случай ранее выставленного webhook — снимаем перед polling
            await bot_app.bot.delete_webhook(drop_pending_updates=True)
            await bot_app.updater.start_polling(drop_pending_updates=True)
            logger.info("Bot started in POLLING mode")
        init_scheduler(bot_app.bot, CHAT_ID, SessionLocal)
        logger.info("Scheduler started")
    else:
        logger.warning("BOT_TOKEN or CHAT_ID not set — bot disabled")
    yield
    if bot_app:
        if not WEBHOOK_URL and bot_app.updater.running:
            await bot_app.updater.stop()
        await bot_app.stop()
        await bot_app.shutdown()


app = FastAPI(title="Deadline Tracker", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/telegram")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
):
    if WEBHOOK_SECRET and x_telegram_bot_api_secret_token != WEBHOOK_SECRET:
        raise HTTPException(status_code=403, detail="Forbidden")
    if not bot_app:
        raise HTTPException(status_code=503, detail="Bot not running")
    data = await request.json()
    update = Update.de_json(data, bot_app.bot)
    await bot_app.process_update(update)
    return {"ok": True}


def _enrich(dl: models.Deadline) -> DeadlineOut:
    return DeadlineOut(
        id=dl.id,
        title=dl.title,
        description=dl.description or "",
        deadline_at=dl.deadline_at,
        color=dl.color,
        archived=dl.archived,
        created_at=dl.created_at,
        reminders=[ReminderOut.model_validate(r) for r in dl.reminders],
        remaining=crud.compute_remaining(dl.deadline_at),
    )


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/deadlines", response_model=list[DeadlineOut])
def list_deadlines(db: Session = Depends(get_db)):
    return [_enrich(dl) for dl in crud.get_deadlines(db)]


@app.post("/api/deadlines", response_model=DeadlineOut, status_code=201)
def create_deadline(data: DeadlineCreate, db: Session = Depends(get_db)):
    dl = crud.create_deadline(db, data)
    return _enrich(dl)


@app.get("/api/deadlines/{deadline_id}", response_model=DeadlineOut)
def get_deadline(deadline_id: int, db: Session = Depends(get_db)):
    dl = crud.get_deadline(db, deadline_id)
    if not dl:
        raise HTTPException(status_code=404, detail="Not found")
    return _enrich(dl)


@app.put("/api/deadlines/{deadline_id}", response_model=DeadlineOut)
def update_deadline(deadline_id: int, data: DeadlineUpdate, db: Session = Depends(get_db)):
    dl = crud.update_deadline(db, deadline_id, data)
    if not dl:
        raise HTTPException(status_code=404, detail="Not found")
    return _enrich(dl)


@app.delete("/api/deadlines/{deadline_id}", status_code=204)
def delete_deadline(deadline_id: int, db: Session = Depends(get_db)):
    if not crud.delete_deadline(db, deadline_id):
        raise HTTPException(status_code=404, detail="Not found")


@app.post("/api/deadlines/{deadline_id}/reminders", response_model=ReminderOut, status_code=201)
def add_reminder(deadline_id: int, data: ReminderCreate, db: Session = Depends(get_db)):
    r = crud.create_reminder(db, deadline_id, data)
    if not r:
        raise HTTPException(status_code=404, detail="Deadline not found")
    return ReminderOut.model_validate(r)


@app.delete("/api/reminders/{reminder_id}", status_code=204)
def delete_reminder(reminder_id: int, db: Session = Depends(get_db)):
    if not crud.delete_reminder(db, reminder_id):
        raise HTTPException(status_code=404, detail="Not found")


frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")

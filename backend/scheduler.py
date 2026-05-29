from apscheduler.schedulers.asyncio import AsyncIOScheduler
from datetime import datetime, timezone, timedelta
from sqlalchemy.orm import Session
from models import ReminderType
from config import LOCAL_TZ, SUMMARY_TIME
import crud
import logging

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler(timezone="UTC")
_bot = None
_chat_id = None
_db_factory = None

SUMMARY_KEY = "last_summary_date"


def init_scheduler(bot, chat_id: int, db_factory):
    global _bot, _chat_id, _db_factory
    _bot = bot
    _chat_id = chat_id
    _db_factory = db_factory
    scheduler.add_job(check_reminders, "interval", seconds=60, id="reminder_check", replace_existing=True)
    scheduler.start()
    logger.info("Scheduler started")


async def check_reminders():
    if not _bot or not _db_factory:
        return
    db: Session = _db_factory()
    try:
        now = datetime.now(timezone.utc)

        # 1) Напоминания «за N времени до события»
        for reminder in crud.get_active_reminders(db):
            if reminder.type != ReminderType.before_minutes:
                continue  # ежедневные напоминания заменены глобальной сводкой
            deadline = reminder.deadline
            deadline_at = deadline.deadline_at
            if deadline_at.tzinfo is None:
                deadline_at = deadline_at.replace(tzinfo=timezone.utc)
            if deadline_at < now:
                continue

            should_send = False
            time_left = (deadline_at - now).total_seconds() / 60
            if time_left <= reminder.offset_minutes:
                if reminder.last_sent_at is None:
                    should_send = True
                else:
                    last = reminder.last_sent_at
                    if last.tzinfo is None:
                        last = last.replace(tzinfo=timezone.utc)
                    if now - last > timedelta(minutes=reminder.offset_minutes):
                        should_send = True

            if should_send:
                remaining = crud.compute_remaining(deadline_at)
                text = _format_reminder(deadline.title, remaining, reminder.offset_minutes)
                try:
                    await _bot.send_message(chat_id=_chat_id, text=text, parse_mode="HTML")
                    crud.mark_reminder_sent(db, reminder.id)
                    logger.info(f"Reminder sent for deadline {deadline.id}")
                except Exception as e:
                    logger.error(f"Failed to send reminder: {e}")

        # 2) Ежедневная сводка (один раз в местные сутки в SUMMARY_TIME)
        await _maybe_send_summary(db, now)
    finally:
        db.close()


async def _maybe_send_summary(db: Session, now: datetime):
    try:
        h, m = map(int, SUMMARY_TIME.split(":"))
    except ValueError:
        return

    local_now = now.astimezone(LOCAL_TZ)
    target = local_now.replace(hour=h, minute=m, second=0, microsecond=0)
    if local_now < target:
        return

    today = local_now.date().isoformat()
    if crud.get_setting(db, SUMMARY_KEY) == today:
        return  # уже отправляли сегодня

    deadlines = crud.get_deadlines(db)
    upcoming = []
    for dl in deadlines:
        r = crud.compute_remaining(dl.deadline_at)
        if not r.is_past:
            upcoming.append((dl, r))

    text = _format_summary(upcoming)
    try:
        await _bot.send_message(chat_id=_chat_id, text=text, parse_mode="HTML")
        crud.set_setting(db, SUMMARY_KEY, today)
        logger.info("Daily summary sent")
    except Exception as e:
        logger.error(f"Failed to send summary: {e}")


def _humanize(r) -> str:
    parts = []
    if r.days:
        parts.append(f"{r.days} д.")
    if r.hours:
        parts.append(f"{r.hours} ч.")
    if r.minutes:
        parts.append(f"{r.minutes} мин.")
    return " ".join(parts) if parts else "менее минуты"


def _format_reminder(title: str, remaining, offset_minutes) -> str:
    if remaining.is_past:
        return f"⏰ <b>Дедлайн прошёл!</b>\n\n📌 {title}"
    if offset_minutes >= 1440:
        label = f"за {offset_minutes // 1440} д."
    elif offset_minutes >= 60:
        label = f"за {offset_minutes // 60} ч."
    else:
        label = f"за {offset_minutes} мин."
    return f"⏰ <b>Напоминание {label}</b>\n\n📌 <b>{title}</b>\n\nОсталось: {_humanize(remaining)}"


def _format_summary(upcoming) -> str:
    if not upcoming:
        return "☀️ <b>Доброе утро!</b>\n\nАктивных дедлайнов нет 🎉"
    lines = ["☀️ <b>Дедлайны на сегодня</b>\n"]
    for dl, r in upcoming:
        lines.append(f"📌 <b>{dl.title}</b> — осталось {_humanize(r)}")
    return "\n".join(lines)

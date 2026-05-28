from apscheduler.schedulers.asyncio import AsyncIOScheduler
from datetime import datetime, timezone, timedelta
from sqlalchemy.orm import Session
from models import ReminderType
import crud
import logging

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler(timezone="UTC")
_bot = None
_chat_id = None
_db_factory = None


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
        reminders = crud.get_active_reminders(db)
        for reminder in reminders:
            deadline = reminder.deadline
            deadline_at = deadline.deadline_at
            if deadline_at.tzinfo is None:
                deadline_at = deadline_at.replace(tzinfo=timezone.utc)

            if deadline_at < now:
                continue

            should_send = False

            if reminder.type == ReminderType.before_minutes:
                time_left = (deadline_at - now).total_seconds() / 60
                if time_left <= reminder.offset_minutes:
                    if reminder.last_sent_at is None:
                        should_send = True
                    else:
                        last = reminder.last_sent_at
                        if last.tzinfo is None:
                            last = last.replace(tzinfo=timezone.utc)
                        window = timedelta(minutes=reminder.offset_minutes)
                        if now - last > window:
                            should_send = True

            elif reminder.type == ReminderType.daily_at:
                try:
                    h, m = map(int, reminder.daily_time.split(":"))
                    target = now.replace(hour=h, minute=m, second=0, microsecond=0)
                    diff = abs((now - target).total_seconds())
                    if diff <= 60:
                        if reminder.last_sent_at is None:
                            should_send = True
                        else:
                            last = reminder.last_sent_at
                            if last.tzinfo is None:
                                last = last.replace(tzinfo=timezone.utc)
                            if (now - last).total_seconds() > 3600:
                                should_send = True
                except ValueError:
                    pass

            if should_send:
                remaining = crud.compute_remaining(deadline_at)
                text = _format_reminder(deadline.title, remaining, reminder.type, reminder.offset_minutes)
                try:
                    await _bot.send_message(chat_id=_chat_id, text=text, parse_mode="HTML")
                    crud.mark_reminder_sent(db, reminder.id)
                    logger.info(f"Reminder sent for deadline {deadline.id}")
                except Exception as e:
                    logger.error(f"Failed to send reminder: {e}")
    finally:
        db.close()


def _format_reminder(title: str, remaining, reminder_type, offset_minutes) -> str:
    if remaining.is_past:
        return f"⏰ <b>Дедлайн прошёл!</b>\n\n📌 {title}"

    parts = []
    if remaining.days:
        parts.append(f"{remaining.days} д.")
    if remaining.hours:
        parts.append(f"{remaining.hours} ч.")
    if remaining.minutes:
        parts.append(f"{remaining.minutes} мин.")
    time_str = " ".join(parts) if parts else "менее минуты"

    if reminder_type == ReminderType.before_minutes and offset_minutes:
        if offset_minutes >= 1440:
            label = f"за {offset_minutes // 1440} д."
        elif offset_minutes >= 60:
            label = f"за {offset_minutes // 60} ч."
        else:
            label = f"за {offset_minutes} мин."
        return f"⏰ <b>Напоминание {label}</b>\n\n📌 <b>{title}</b>\n\nОсталось: {time_str}"

    return f"☀️ <b>Ежедневная сводка</b>\n\n📌 <b>{title}</b>\n\nОсталось: {time_str}"

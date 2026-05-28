from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    ConversationHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
    ContextTypes,
)
from datetime import datetime, timezone
from dateutil import parser as dateparser
import crud
from schemas import DeadlineCreate, ReminderCreate
from models import ReminderType
import logging

logger = logging.getLogger(__name__)

TITLE, DATETIME_INPUT, REMINDER_CHOICE, DAILY_TIME_INPUT = range(4)

REMINDER_OPTIONS = [
    ("⏱ За 30 минут", "before_30"),
    ("⏰ За 1 час", "before_60"),
    ("🕐 За 2 часа", "before_120"),
    ("📅 За 1 день", "before_1440"),
    ("☀️ Ежедневно в 9:00", "daily_09:00"),
    ("🌙 Ежедневно в 21:00", "daily_21:00"),
    ("⚙️ Своё время", "daily_custom"),
    ("➡️ Пропустить", "skip"),
]

_db_factory = None
_allowed_id = None


def init_bot(db_factory, allowed_chat_id: int):
    global _db_factory, _allowed_id
    _db_factory = db_factory
    _allowed_id = allowed_chat_id


def _get_db():
    db = _db_factory()
    try:
        return db
    except Exception:
        db.close()
        raise


def _auth(update: Update) -> bool:
    return update.effective_user.id == _allowed_id


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _auth(update):
        return
    await update.message.reply_text(
        "👋 <b>Трекер дедлайнов</b>\n\n"
        "/list — список дедлайнов\n"
        "/add — добавить дедлайн\n"
        "/delete &lt;id&gt; — удалить дедлайн\n"
        "/today — дедлайны на сегодня и завтра",
        parse_mode="HTML",
    )


async def list_deadlines(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _auth(update):
        return
    db = _db_factory()
    try:
        deadlines = crud.get_deadlines(db)
        if not deadlines:
            await update.message.reply_text("Нет активных дедлайнов. Добавь первый: /add")
            return
        lines = []
        for dl in deadlines:
            r = crud.compute_remaining(dl.deadline_at)
            if r.is_past:
                status = "✅ завершён"
            elif r.total_seconds < 86400:
                status = f"🔴 {r.hours}ч {r.minutes}м"
            elif r.total_seconds < 259200:
                status = f"🟡 {r.days}д {r.hours}ч"
            else:
                status = f"🟢 {r.days}д {r.hours}ч"
            lines.append(f"<b>#{dl.id}</b> {dl.title}\n   {status}")

        await update.message.reply_text("\n\n".join(lines), parse_mode="HTML")
    finally:
        db.close()


async def today_deadlines(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _auth(update):
        return
    db = _db_factory()
    try:
        deadlines = crud.get_deadlines(db)
        now = datetime.now(timezone.utc)
        upcoming = []
        for dl in deadlines:
            r = crud.compute_remaining(dl.deadline_at)
            if not r.is_past and r.total_seconds <= 172800:
                upcoming.append((dl, r))

        if not upcoming:
            await update.message.reply_text("На ближайшие 48 часов дедлайнов нет 🎉")
            return

        lines = ["📋 <b>Ближайшие дедлайны:</b>\n"]
        for dl, r in upcoming:
            parts = []
            if r.days:
                parts.append(f"{r.days} д.")
            if r.hours:
                parts.append(f"{r.hours} ч.")
            if r.minutes:
                parts.append(f"{r.minutes} мин.")
            time_str = " ".join(parts) or "менее минуты"
            lines.append(f"📌 <b>{dl.title}</b>\nОсталось: {time_str}")

        await update.message.reply_text("\n\n".join(lines), parse_mode="HTML")
    finally:
        db.close()


async def add_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _auth(update):
        return
    await update.message.reply_text(
        "📝 <b>Новый дедлайн</b>\n\nВведи название:",
        parse_mode="HTML",
    )
    return TITLE


async def add_title(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["title"] = update.message.text.strip()
    await update.message.reply_text(
        "📅 Введи дату и время дедлайна.\n\n"
        "Примеры:\n"
        "<code>25.06.2026 18:00</code>\n"
        "<code>25 июня 2026 18:00</code>\n"
        "<code>2026-06-25 18:00</code>",
        parse_mode="HTML",
    )
    return DATETIME_INPUT


async def add_datetime(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    try:
        dt = dateparser.parse(text, dayfirst=True)
        if dt is None:
            raise ValueError
        dt = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
        context.user_data["deadline_at"] = dt
    except (ValueError, OverflowError):
        await update.message.reply_text("❌ Не могу распознать дату. Попробуй формат: <code>25.06.2026 18:00</code>", parse_mode="HTML")
        return DATETIME_INPUT

    keyboard = [
        [InlineKeyboardButton(label, callback_data=cb)]
        for label, cb in REMINDER_OPTIONS
    ]
    await update.message.reply_text(
        f"✅ Дата: <b>{dt.strftime('%d.%m.%Y %H:%M')} UTC</b>\n\nВыбери напоминание:",
        parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return REMINDER_CHOICE


async def add_reminder_choice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    db = _db_factory()
    try:
        deadline = crud.create_deadline(
            db,
            DeadlineCreate(
                title=context.user_data["title"],
                deadline_at=context.user_data["deadline_at"],
            ),
        )
        context.user_data["new_deadline_id"] = deadline.id

        if data == "skip":
            await query.edit_message_text(f"✅ Дедлайн <b>{deadline.title}</b> создан!", parse_mode="HTML")
            return ConversationHandler.END

        if data.startswith("daily_") and not data.startswith("daily_custom"):
            time_str = data.replace("daily_", "")
            crud.create_reminder(db, deadline.id, ReminderCreate(type=ReminderType.daily_at, daily_time=time_str))
            await query.edit_message_text(
                f"✅ Дедлайн <b>{deadline.title}</b> создан!\n🔔 Напоминание: ежедневно в {time_str}",
                parse_mode="HTML",
            )
            return ConversationHandler.END

        if data == "daily_custom":
            await query.edit_message_text("⏰ Введи время для ежедневного напоминания (например: <code>08:30</code>):", parse_mode="HTML")
            return DAILY_TIME_INPUT

        if data.startswith("before_"):
            minutes = int(data.replace("before_", ""))
            crud.create_reminder(db, deadline.id, ReminderCreate(type=ReminderType.before_minutes, offset_minutes=minutes))
            label = f"{minutes // 60} ч." if minutes >= 60 else f"{minutes} мин."
            await query.edit_message_text(
                f"✅ Дедлайн <b>{deadline.title}</b> создан!\n🔔 Напоминание: за {label}",
                parse_mode="HTML",
            )
            return ConversationHandler.END

    finally:
        db.close()


async def add_daily_time(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    try:
        h, m = map(int, text.split(":"))
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError
        time_str = f"{h:02d}:{m:02d}"
    except ValueError:
        await update.message.reply_text("❌ Неверный формат. Введи время как <code>08:30</code>:", parse_mode="HTML")
        return DAILY_TIME_INPUT

    db = _db_factory()
    try:
        deadline_id = context.user_data.get("new_deadline_id")
        crud.create_reminder(db, deadline_id, ReminderCreate(type=ReminderType.daily_at, daily_time=time_str))
        title = context.user_data.get("title", "")
        await update.message.reply_text(
            f"✅ Дедлайн <b>{title}</b> создан!\n🔔 Напоминание: ежедневно в {time_str}",
            parse_mode="HTML",
        )
    finally:
        db.close()
    return ConversationHandler.END


async def delete_deadline(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _auth(update):
        return
    if not context.args:
        await update.message.reply_text("Укажи ID: /delete 3")
        return
    try:
        dl_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("ID должен быть числом.")
        return

    db = _db_factory()
    try:
        dl = crud.get_deadline(db, dl_id)
        if not dl:
            await update.message.reply_text(f"Дедлайн #{dl_id} не найден.")
            return
        title = dl.title
        crud.delete_deadline(db, dl_id)
        await update.message.reply_text(f"🗑 Дедлайн <b>{title}</b> удалён.", parse_mode="HTML")
    finally:
        db.close()


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    await update.message.reply_text("❌ Отменено.")
    return ConversationHandler.END


def build_application(token: str) -> Application:
    app = Application.builder().token(token).build()

    conv = ConversationHandler(
        entry_points=[CommandHandler("add", add_start)],
        states={
            TITLE: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_title)],
            DATETIME_INPUT: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_datetime)],
            REMINDER_CHOICE: [CallbackQueryHandler(add_reminder_choice)],
            DAILY_TIME_INPUT: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_daily_time)],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("list", list_deadlines))
    app.add_handler(CommandHandler("today", today_deadlines))
    app.add_handler(CommandHandler("delete", delete_deadline))
    app.add_handler(conv)

    return app

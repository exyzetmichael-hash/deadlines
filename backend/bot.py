import re
import logging
from datetime import datetime, timezone

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, BotCommand
from telegram.ext import (
    Application,
    CommandHandler,
    ConversationHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
    ContextTypes,
)
from dateutil import parser as dateparser

import crud
from config import LOCAL_TZ
from schemas import DeadlineCreate, ReminderCreate
from models import ReminderType

logger = logging.getLogger(__name__)

TITLE, DATETIME_INPUT, REMINDER_MENU, CUSTOM_INTERVAL_INPUT = range(4)

# Пресеты «за N времени до события» (минуты)
BEFORE_PRESETS = [
    (30, "За 30 мин"),
    (60, "За 1 час"),
    (120, "За 2 часа"),
    (1440, "За 1 день"),
]

_db_factory = None
_allowed_id = None


def init_bot(db_factory, allowed_chat_id: int):
    global _db_factory, _allowed_id
    _db_factory = db_factory
    _allowed_id = allowed_chat_id


def _auth(update: Update) -> bool:
    return update.effective_user.id == _allowed_id


def fmt_local(dt: datetime) -> str:
    """Дата дедлайна в часовом поясе пользователя."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(LOCAL_TZ).strftime("%d.%m.%Y %H:%M")


def humanize_remaining(r) -> str:
    parts = []
    if r.days:
        parts.append(f"{r.days} д.")
    if r.hours:
        parts.append(f"{r.hours} ч.")
    if r.minutes:
        parts.append(f"{r.minutes} мин.")
    return " ".join(parts) if parts else "менее минуты"


def reminder_label(r) -> str:
    if r["type"] == ReminderType.before_minutes:
        m = r["offset_minutes"]
        if m % 1440 == 0:
            return f"за {m // 1440} д."
        if m >= 60 and m % 60 == 0:
            return f"за {m // 60} ч."
        if m >= 60:
            return f"за {m // 60} ч. {m % 60} мин."
        return f"за {m} мин."
    return f"ежедневно в {r['daily_time']}"


def parse_interval(text: str):
    """Парсит '90', '2ч', '1д 3ч', 'за 2 часа 30 минут' -> минуты или None."""
    text = text.lower().strip()
    if text.isdigit():
        val = int(text)
        return val if val > 0 else None
    total = 0
    found = False
    for num, unit in re.findall(r"(\d+)\s*([а-яёa-z]+)", text):
        n = int(num)
        if unit[0] in ("д", "d"):
            total += n * 1440
            found = True
        elif unit[0] in ("ч", "h"):
            total += n * 60
            found = True
        elif unit[0] in ("м", "m"):
            total += n
            found = True
    return total if (found and total > 0) else None


# ─── Простые команды ──────────────────────────────────────────────────────
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _auth(update):
        return
    await update.message.reply_text(
        "👋 <b>Трекер дедлайнов</b>\n\n"
        "Нажми кнопку меню (☰) рядом с полем ввода или используй команды:\n\n"
        "/add — добавить дедлайн\n"
        "/list — список дедлайнов\n"
        "/today — ближайшие 48 часов\n"
        "/delete &lt;id&gt; — удалить\n"
        "/help — справка",
        parse_mode="HTML",
    )


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _auth(update):
        return
    await update.message.reply_text(
        "ℹ️ <b>Справка</b>\n\n"
        "<b>/add</b> — мастер создания: название → дата → напоминания.\n"
        "Напоминания «за N времени до события», можно несколько сразу.\n"
        "Кнопка «⚙️ Свой интервал» — например <code>за 3 часа 30 минут</code> или <code>90</code> (минут).\n\n"
        "☀️ <b>Сводка</b> приходит автоматически каждое утро — одним сообщением "
        "со всеми активными дедлайнами.\n\n"
        "<b>/list</b> — все дедлайны с обратным отсчётом.\n"
        "<b>/today</b> — что горит в ближайшие 48 часов.\n"
        "<b>/delete 3</b> — удалить дедлайн с id 3.\n"
        "<b>/cancel</b> — прервать создание.",
        parse_mode="HTML",
    )


async def list_deadlines(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _auth(update):
        return
    db = _db_factory()
    try:
        deadlines = [d for d in crud.get_deadlines(db) if not d.archived]
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
            rem = ""
            if dl.reminders:
                rem = "\n   🔔 " + ", ".join(
                    reminder_label({
                        "type": x.type,
                        "offset_minutes": x.offset_minutes,
                        "daily_time": x.daily_time,
                    })
                    for x in dl.reminders
                )
            lines.append(f"<b>#{dl.id}</b> {dl.title}\n   {status} · {fmt_local(dl.deadline_at)}{rem}")
        await update.message.reply_text("\n\n".join(lines), parse_mode="HTML")
    finally:
        db.close()


async def today_deadlines(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _auth(update):
        return
    db = _db_factory()
    try:
        deadlines = crud.get_deadlines(db)
        upcoming = []
        for dl in deadlines:
            if dl.archived:
                continue
            r = crud.compute_remaining(dl.deadline_at)
            if not r.is_past and r.total_seconds <= 172800:
                upcoming.append((dl, r))
        if not upcoming:
            await update.message.reply_text("На ближайшие 48 часов дедлайнов нет 🎉")
            return
        lines = ["📋 <b>Ближайшие дедлайны:</b>\n"]
        for dl, r in upcoming:
            lines.append(f"📌 <b>{dl.title}</b>\nОсталось: {humanize_remaining(r)}")
        await update.message.reply_text("\n\n".join(lines), parse_mode="HTML")
    finally:
        db.close()


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


# ─── Мастер /add ──────────────────────────────────────────────────────────
async def add_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _auth(update):
        return ConversationHandler.END
    context.user_data.clear()
    await update.message.reply_text("📝 <b>Новый дедлайн</b>\n\nВведи название:", parse_mode="HTML")
    return TITLE


async def add_title(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["title"] = update.message.text.strip()
    await update.message.reply_text(
        "📅 Введи дату и время дедлайна (по твоему местному времени).\n\n"
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
        # Введённое время трактуем как местное (LOCAL_TZ) и переводим в UTC
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=LOCAL_TZ)
        dt = dt.astimezone(timezone.utc)
        context.user_data["deadline_at"] = dt
    except (ValueError, OverflowError):
        await update.message.reply_text(
            "❌ Не могу распознать дату. Попробуй формат: <code>25.06.2026 18:00</code>",
            parse_mode="HTML",
        )
        return DATETIME_INPUT

    context.user_data["reminders"] = []
    await update.message.reply_text(
        f"✅ Дата: <b>{fmt_local(dt)}</b>\n\nВыбери напоминания (можно несколько), потом «Готово»:",
        parse_mode="HTML",
        reply_markup=_reminder_keyboard(context.user_data["reminders"]),
    )
    return REMINDER_MENU


def _reminder_keyboard(selected: list) -> InlineKeyboardMarkup:
    def is_sel(type_, **kw):
        for r in selected:
            if r["type"] == type_:
                if type_ == ReminderType.before_minutes and r["offset_minutes"] == kw.get("offset"):
                    return True
                if type_ == ReminderType.daily_at and r["daily_time"] == kw.get("time"):
                    return True
        return False

    rows = []
    for minutes, label in BEFORE_PRESETS:
        mark = "✅ " if is_sel(ReminderType.before_minutes, offset=minutes) else ""
        rows.append([InlineKeyboardButton(f"{mark}{label}", callback_data=f"t:before:{minutes}")])
    rows.append([InlineKeyboardButton("⚙️ Свой интервал", callback_data="custom_interval")])
    rows.append([InlineKeyboardButton("✔️ Готово", callback_data="done")])
    return InlineKeyboardMarkup(rows)


def _menu_text(context) -> str:
    selected = context.user_data.get("reminders", [])
    base = "Выбери напоминания (можно несколько), потом «Готово»:"
    if selected:
        chosen = ", ".join(reminder_label(r) for r in selected)
        return f"{base}\n\n🔔 Выбрано: {chosen}"
    return base


async def reminder_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    selected = context.user_data.setdefault("reminders", [])

    if data == "done":
        return await _finish(update, context, via_query=True)

    if data == "custom_interval":
        await query.edit_message_text(
            "⚙️ Введи интервал до события.\n\n"
            "Примеры: <code>90</code> (минут), <code>3ч</code>, <code>1д 6ч</code>, <code>за 2 часа 30 минут</code>",
            parse_mode="HTML",
        )
        return CUSTOM_INTERVAL_INPUT

    # Переключение пресета
    if data.startswith("t:before:"):
        minutes = int(data.split(":")[2])
        _toggle(selected, {"type": ReminderType.before_minutes, "offset_minutes": minutes, "daily_time": None})

    await query.edit_message_text(
        _menu_text(context), parse_mode="HTML", reply_markup=_reminder_keyboard(selected)
    )
    return REMINDER_MENU


def _toggle(selected: list, item: dict):
    for i, r in enumerate(selected):
        same = r["type"] == item["type"] and (
            r["offset_minutes"] == item["offset_minutes"]
            if item["type"] == ReminderType.before_minutes
            else r["daily_time"] == item["daily_time"]
        )
        if same:
            selected.pop(i)
            return
    selected.append(item)


async def add_custom_interval(update: Update, context: ContextTypes.DEFAULT_TYPE):
    minutes = parse_interval(update.message.text)
    if not minutes:
        await update.message.reply_text(
            "❌ Не понял интервал. Примеры: <code>90</code>, <code>3ч</code>, <code>1д 6ч</code>",
            parse_mode="HTML",
        )
        return CUSTOM_INTERVAL_INPUT
    selected = context.user_data.setdefault("reminders", [])
    _toggle(selected, {"type": ReminderType.before_minutes, "offset_minutes": minutes, "daily_time": None})
    await update.message.reply_text(
        _menu_text(context), parse_mode="HTML", reply_markup=_reminder_keyboard(selected)
    )
    return REMINDER_MENU


async def _finish(update: Update, context: ContextTypes.DEFAULT_TYPE, via_query=False):
    db = _db_factory()
    try:
        deadline = crud.create_deadline(
            db,
            DeadlineCreate(
                title=context.user_data["title"],
                deadline_at=context.user_data["deadline_at"],
            ),
        )
        reminders = context.user_data.get("reminders", [])
        for r in reminders:
            if r["type"] == ReminderType.before_minutes:
                crud.create_reminder(db, deadline.id, ReminderCreate(
                    type=ReminderType.before_minutes, offset_minutes=r["offset_minutes"]))
            else:
                crud.create_reminder(db, deadline.id, ReminderCreate(
                    type=ReminderType.daily_at, daily_time=r["daily_time"]))

        if reminders:
            rem_txt = "\n🔔 Напоминания: " + ", ".join(reminder_label(r) for r in reminders)
        else:
            rem_txt = "\n🔔 Без напоминаний"
        msg = f"✅ Дедлайн <b>{deadline.title}</b> создан!\n📅 {fmt_local(deadline.deadline_at)}{rem_txt}"
    finally:
        db.close()

    if via_query:
        await update.callback_query.edit_message_text(msg, parse_mode="HTML")
    else:
        await update.message.reply_text(msg, parse_mode="HTML")
    context.user_data.clear()
    return ConversationHandler.END


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    await update.message.reply_text("❌ Отменено.")
    return ConversationHandler.END


BOT_COMMANDS = [
    BotCommand("add", "Добавить дедлайн"),
    BotCommand("list", "Список дедлайнов"),
    BotCommand("today", "Ближайшие 48 часов"),
    BotCommand("delete", "Удалить дедлайн по id"),
    BotCommand("help", "Справка"),
    BotCommand("cancel", "Отменить создание"),
]


# ─── Сборка приложения ──────────────────────────────────────────────────────
def build_application(token: str) -> Application:
    app = Application.builder().token(token).build()

    conv = ConversationHandler(
        entry_points=[CommandHandler("add", add_start)],
        states={
            TITLE: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_title)],
            DATETIME_INPUT: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_datetime)],
            REMINDER_MENU: [CallbackQueryHandler(reminder_menu)],
            CUSTOM_INTERVAL_INPUT: [MessageHandler(filters.TEXT & ~filters.COMMAND, add_custom_interval)],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("list", list_deadlines))
    app.add_handler(CommandHandler("today", today_deadlines))
    app.add_handler(CommandHandler("delete", delete_deadline))
    app.add_handler(conv)
    app.add_error_handler(_on_error)

    return app


async def _on_error(update: object, context: ContextTypes.DEFAULT_TYPE):
    logger.error("Bot handler error", exc_info=context.error)

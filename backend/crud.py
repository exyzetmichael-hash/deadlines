from sqlalchemy.orm import Session
from datetime import datetime, timezone
from models import Deadline, Reminder
from schemas import DeadlineCreate, DeadlineUpdate, ReminderCreate, RemainingTime


def compute_remaining(deadline_at: datetime) -> RemainingTime:
    now = datetime.now(timezone.utc)
    if deadline_at.tzinfo is None:
        deadline_at = deadline_at.replace(tzinfo=timezone.utc)
    delta = deadline_at - now
    total = int(delta.total_seconds())
    is_past = total <= 0
    total = abs(total)
    days = total // 86400
    hours = (total % 86400) // 3600
    minutes = (total % 3600) // 60
    seconds = total % 60
    return RemainingTime(days=days, hours=hours, minutes=minutes, seconds=seconds, total_seconds=total, is_past=is_past)


def get_deadlines(db: Session) -> list[Deadline]:
    return db.query(Deadline).order_by(Deadline.deadline_at).all()


def get_deadline(db: Session, deadline_id: int) -> Deadline | None:
    return db.query(Deadline).filter(Deadline.id == deadline_id).first()


def create_deadline(db: Session, data: DeadlineCreate) -> Deadline:
    dl = Deadline(**data.model_dump())
    db.add(dl)
    db.commit()
    db.refresh(dl)
    return dl


def update_deadline(db: Session, deadline_id: int, data: DeadlineUpdate) -> Deadline | None:
    dl = get_deadline(db, deadline_id)
    if not dl:
        return None
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(dl, field, value)
    dl.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(dl)
    return dl


def delete_deadline(db: Session, deadline_id: int) -> bool:
    dl = get_deadline(db, deadline_id)
    if not dl:
        return False
    db.delete(dl)
    db.commit()
    return True


def create_reminder(db: Session, deadline_id: int, data: ReminderCreate) -> Reminder | None:
    if not get_deadline(db, deadline_id):
        return None
    reminder = Reminder(deadline_id=deadline_id, **data.model_dump())
    db.add(reminder)
    db.commit()
    db.refresh(reminder)
    return reminder


def get_reminder(db: Session, reminder_id: int) -> Reminder | None:
    return db.query(Reminder).filter(Reminder.id == reminder_id).first()


def delete_reminder(db: Session, reminder_id: int) -> bool:
    r = get_reminder(db, reminder_id)
    if not r:
        return False
    db.delete(r)
    db.commit()
    return True


def get_active_reminders(db: Session) -> list[Reminder]:
    return db.query(Reminder).filter(Reminder.is_active == True).all()


def mark_reminder_sent(db: Session, reminder_id: int):
    r = get_reminder(db, reminder_id)
    if r:
        r.last_sent_at = datetime.now(timezone.utc)
        db.commit()

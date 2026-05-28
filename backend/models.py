from sqlalchemy import Column, Integer, String, DateTime, Boolean, ForeignKey, Enum
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
import enum
from database import Base


class ReminderType(str, enum.Enum):
    before_minutes = "before_minutes"
    daily_at = "daily_at"


class Deadline(Base):
    __tablename__ = "deadlines"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    description = Column(String, default="")
    deadline_at = Column(DateTime, nullable=False)
    color = Column(String, default="#6366f1")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    reminders = relationship("Reminder", back_populates="deadline", cascade="all, delete-orphan")


class Reminder(Base):
    __tablename__ = "reminders"

    id = Column(Integer, primary_key=True, index=True)
    deadline_id = Column(Integer, ForeignKey("deadlines.id"), nullable=False)
    type = Column(Enum(ReminderType), nullable=False)
    offset_minutes = Column(Integer, nullable=True)
    daily_time = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    last_sent_at = Column(DateTime, nullable=True)

    deadline = relationship("Deadline", back_populates="reminders")

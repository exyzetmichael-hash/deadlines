from pydantic import BaseModel, field_validator
from datetime import datetime, timezone
from typing import Optional
from models import ReminderType


class RemainingTime(BaseModel):
    days: int
    hours: int
    minutes: int
    seconds: int
    total_seconds: int
    is_past: bool


class ReminderCreate(BaseModel):
    type: ReminderType
    offset_minutes: Optional[int] = None
    daily_time: Optional[str] = None

    @field_validator("offset_minutes")
    @classmethod
    def validate_offset(cls, v, info):
        if info.data.get("type") == ReminderType.before_minutes and v is None:
            raise ValueError("offset_minutes required for before_minutes type")
        return v

    @field_validator("daily_time")
    @classmethod
    def validate_daily_time(cls, v, info):
        if info.data.get("type") == ReminderType.daily_at and v is None:
            raise ValueError("daily_time required for daily_at type")
        return v


class ReminderOut(BaseModel):
    id: int
    type: ReminderType
    offset_minutes: Optional[int]
    daily_time: Optional[str]
    is_active: bool
    last_sent_at: Optional[datetime]

    model_config = {"from_attributes": True}


class DeadlineCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    deadline_at: datetime
    color: Optional[str] = "#6366f1"

    @field_validator("deadline_at")
    @classmethod
    def ensure_utc(cls, v):
        if v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class DeadlineUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    deadline_at: Optional[datetime] = None
    color: Optional[str] = None
    archived: Optional[bool] = None

    @field_validator("deadline_at")
    @classmethod
    def ensure_utc(cls, v):
        if v is not None and v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v


class DeadlineOut(BaseModel):
    id: int
    title: str
    description: str
    deadline_at: datetime
    color: str
    archived: bool
    created_at: datetime
    reminders: list[ReminderOut]
    remaining: RemainingTime

    model_config = {"from_attributes": True}

import os
from datetime import timezone
from zoneinfo import ZoneInfo

# Часовой пояс пользователя. Задаётся переменной окружения TZ
# (например, Asia/Krasnoyarsk для UTC+7). По умолчанию UTC.
try:
    LOCAL_TZ = ZoneInfo(os.getenv("TZ", "UTC"))
except Exception:
    LOCAL_TZ = timezone.utc

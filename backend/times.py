from datetime import datetime, timedelta, timezone

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
ISO_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


def utc_now():
    return datetime.now(timezone.utc)


def iso_millis(moment):
    """Formats a time like JavaScript's toISOString(), e.g. 2026-10-05T14:12:08.123Z."""
    moment = moment.astimezone(timezone.utc) if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def parse_iso_millis(text):
    """Milliseconds since 1970 for a real time in toISOString() format, or None for an
    impossible one such as 2026-02-30 (JavaScript would silently roll it over to March)."""
    try:
        moment = datetime.strptime(text, ISO_FORMAT).replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (moment - EPOCH) // timedelta(milliseconds=1)

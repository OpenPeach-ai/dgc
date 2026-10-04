"""Reviewed calendar-day windows, resolved once by the controller per run."""
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from .workspace_registry import RegistryError


def validate(value):
    if (not isinstance(value,dict) or set(value)!={'kind','timezone','start_day','days'}
            or value['kind']!='calendar_days' or type(value['start_day']) is not int
            or not 0<=value['start_day']<=30 or type(value['days']) is not int
            or not 1<=value['days']<=31 or not isinstance(value['timezone'],str)
            or not 1<=len(value['timezone'])<=100):
        raise RegistryError('invalid_calendar_window','Review a timezone, start day (0–30) and length (1–31 days).')
    try:ZoneInfo(value['timezone'])
    except (ValueError,ZoneInfoNotFoundError) as exc:
        raise RegistryError('invalid_calendar_window','The runner does not have this timezone. Choose an available IANA timezone.') from exc
    return value


def resolve(value,now):
    validate(value)
    if not isinstance(now,datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise RegistryError('invalid_calendar_window','Calendar windows require an aware controller clock.')
    zone=ZoneInfo(value['timezone'])
    try:
        first=now.astimezone(zone).date()+timedelta(days=value['start_day'])
        last=first+timedelta(days=value['days'])
        def midnight(day):
            naive=datetime.combine(day,time.min)
            # fold=0 chooses the first midnight on days with a repeated midnight.
            local=naive.replace(tzinfo=zone,fold=0)
            if local.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)!=naive:
                raise RegistryError('invalid_calendar_window','This calendar boundary does not exist in the reviewed timezone. Review a different window.')
            return local.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')
        return {'time_min':midnight(first),'time_max':midnight(last)}
    except (OverflowError,ValueError) as exc:
        raise RegistryError('invalid_calendar_window','The calendar window is outside the supported date range.') from exc

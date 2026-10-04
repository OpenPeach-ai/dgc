"""One reviewed, account-specific calendar creation, optionally a finite series.

Contract checked against Composio metadata on 2026-10-04. The current contract
uses string send_updates='none', unlike the older v3 docs' boolean field.
https://docs.composio.dev/toolkits/googlecalendar
"""
from __future__ import annotations

import html
import json
import re
import time
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import pip_app_access as apps, pip_app_sends as sends
from .workspace_registry import RegistryError

TOOL = 'GOOGLECALENDAR_CREATE_EVENT'
FIELDS = {'summary', 'description', 'start_datetime', 'end_datetime', 'timezone'}
OPTIONS = {'attendees', 'repeat', 'send_invitations'}
FIXED = {'calendar_id':'primary', 'attendees':[], 'recurrence':[], 'send_updates':'none',
         'eventType':'default', 'visibility':'private', 'transparency':'opaque',
         'create_meeting_room':False, 'exclude_organizer':True, 'guestsCanModify':False,
         'guestsCanInviteOthers':False, 'guestsCanSeeOtherGuests':False}
TYPES = {key:('boolean' if type(value) is bool else 'array' if isinstance(value,list) else 'string')
         for key,value in FIXED.items()} | {key:'string' for key in FIELDS}
ACCEPTED = 'Provider confirmed creation of this calendar event.'


def extended(event):
    return isinstance(event,dict) and bool(OPTIONS.intersection(event))


def options(event):
    """Closed, explicit additions. Never infer guests or an unlimited series."""
    if not extended(event):return [],[],False
    attendees=event.get('attendees');repeat=event.get('repeat');notify=event.get('send_invitations')
    if not isinstance(attendees,list) or len(attendees)>10 or type(notify) is not bool or notify!=bool(attendees):
        raise RegistryError('invalid_calendar_event','Review up to ten guest emails. Sending invitations must be explicitly on exactly when guests are present.')
    seen=set()
    for address in attendees:
        try:sends.arguments({'recipient_email':address,'subject':'Calendar invitation','body':'Reviewed event'})
        except (RegistryError,TypeError,AttributeError) as exc:
            raise RegistryError('invalid_calendar_event','Each guest must be one exact email address, without a display name.') from exc
        if address!=address.strip() or address.casefold() in seen:
            raise RegistryError('invalid_calendar_event','Guest addresses must be trimmed and unique.')
        seen.add(address.casefold())
    if repeat is None:return list(attendees),[],notify
    if (not isinstance(repeat,dict) or set(repeat)!={'frequency','interval','count'}
            or repeat['frequency'] not in ('daily','weekly','monthly')
            or type(repeat['interval']) is not int or not 1<=repeat['interval']<=12
            or type(repeat['count']) is not int or not 2<=repeat['count']<=52):
        raise RegistryError('invalid_calendar_event','Choose daily, weekly or monthly, every 1–12 periods, for 2–52 occurrences including the first.')
    return list(attendees),[f"RRULE:FREQ={repeat['frequency'].upper()};INTERVAL={repeat['interval']};COUNT={repeat['count']}"],notify


def event_schema():
    return {'type':'object','additionalProperties':False,'required':sorted(FIELDS),
            'properties':{**{k:{'type':'string'} for k in sorted(FIELDS)},
                'attendees':{'type':'array','maxItems':10,'items':{'type':'string'},'description':'Exact user-provided guest email addresses. Include repeat and send_invitations whenever this is present.'},
                'send_invitations':{'type':'boolean','description':'Must be true for guests; false without guests. This drafts an invitation, it does not send it.'},
                'repeat':{'description':'Null for one event; otherwise finite occurrences including the first. Include attendees and send_invitations when present.',
                    'anyOf':[{'type':'null'},{'type':'object','additionalProperties':False,'required':['frequency','interval','count'],
                        'properties':{'frequency':{'type':'string','enum':['daily','weekly','monthly']},'interval':{'type':'integer','minimum':1,'maximum':12},'count':{'type':'integer','minimum':2,'maximum':52}}}]}}}


def instant(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})',value):
        raise RegistryError('invalid_calendar_event','Use exact date-times with seconds and a UTC offset or Z.')
    try:
        if not value.endswith('Z') and (int(value[-5:-3])>14 or int(value[-2:])>59):raise ValueError()
        parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
        if parsed.utcoffset() is None or abs(parsed.utcoffset())>timedelta(hours=14):raise ValueError()
        return parsed
    except ValueError as exc:
        raise RegistryError('invalid_calendar_event','The calendar date or UTC offset is invalid.') from exc


def arguments(event):
    apps.bounded(event,12000)
    if not isinstance(event,dict) or set(event) not in (FIELDS,FIELDS|OPTIONS):
        raise RegistryError('invalid_calendar_event','Review title, description, exact start/end and IANA time zone. To add guests or repeats, include attendees, repeat and send_invitations together.')
    attendees,recurrence,notify=options(event)
    for key,limit in (('summary',200),('description',8000),('timezone',80)):
        value=event[key]
        if (not isinstance(value,str) or value!=value.strip() or (not value and key!='description')
                or len(value.encode())>limit or any(unicodedata.category(c).startswith('C') and not (key=='description' and c in '\n\t') for c in value)):
            raise RegistryError('invalid_calendar_event','Review trimmed text without invisible controls; title 200 bytes and description 8,000 bytes maximum.')
    tz=event['timezone']
    if not re.fullmatch(r'(?:UTC|[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+)+)',tz):
        raise RegistryError('invalid_calendar_event','Choose UTC or a named IANA time zone, not a local abbreviation.')
    try:zone=ZoneInfo(tz)
    except (ZoneInfoNotFoundError,ValueError) as exc:
        raise RegistryError('invalid_calendar_event','That IANA time zone is unavailable on this runner.') from exc
    start,end=instant(event['start_datetime']),instant(event['end_datetime'])
    for value in (start,end):
        local=value.astimezone(zone)
        if local.replace(tzinfo=None)!=value.replace(tzinfo=None) or local.utcoffset()!=value.utcoffset():
            raise RegistryError('invalid_calendar_event','The explicit offset does not match the named time zone at that date. Review the local time, including daylight saving.')
    duration=end.astimezone(timezone.utc)-start.astimezone(timezone.utc)
    if not timedelta(0)<duration<=timedelta(days=7):
        raise RegistryError('invalid_calendar_event','End must be after start, with an event duration no longer than seven days.')
    return {**{k:event[k] for k in FIELDS},'description':html.escape(event['description']),
            **{key:list(value) if isinstance(value,list) else value for key,value in FIXED.items()},
            'attendees':attendees,'recurrence':recurrence,'send_updates':'all' if notify else 'none'}


def route(manager,name,cancel):
    return sends.route(manager,name,cancel,tool=TOOL,argument_types=TYPES)


def inspect(config,name,*,manager_factory=apps._manager,clock=time.monotonic):
    spec,fingerprint=apps.connection(config,name)
    if not apps.supported(spec):raise RegistryError('unsupported_connector','This connector has no scoped calendar creation adapter.')
    cancel=apps.DeadlineCancellation(clock()+30,clock=clock);manager=manager_factory(config,name,cancel)
    try:
        _,schema_digest=route(manager,name,cancel)
        if apps.connection(config,name)[1]!=fingerprint:raise RegistryError('connection_changed','Connection changed during discovery.')
        return {'server':name,'connection_digest':fingerprint,'tool':TOOL,'schema_digest':schema_digest,
                'account_required':True,'notice':'One reviewed creation in the chosen account’s primary calendar, optionally a finite series and up to ten named guests. Guests receive invitation requests; delivery and acceptance are not confirmed. No meeting link. Calendar reminders and sharing policies may still apply.'}
    finally:manager.stop_all()


def validate_receipt(receipt):
    if (not isinstance(receipt,dict) or set(receipt)!={'provider','event_id','meaning'}
            or receipt['provider']!='Google Calendar' or receipt['meaning']!=ACCEPTED
            or not isinstance(receipt['event_id'],str) or not re.fullmatch(r'[a-v0-9]{5,1024}',receipt['event_id'])):
        raise RegistryError('invalid_calendar_receipt','The provider did not confirm this calendar event.')
    return receipt


def result(raw,event):
    if not isinstance(raw,str) or len(raw)>32768 or len(raw.encode())>32768:raise ValueError('receipt limit')
    outer=json.loads(raw)
    if outer.get('successful') is not True or outer.get('error') is not None:raise ValueError('executor error')
    data=outer['data'];rows=data['results']
    if data.get('success') is not True or not isinstance(rows,list) or len(rows)!=1:raise ValueError('executor result')
    row=rows[0];response=row['response'];value=response['data']
    if row.get('tool_slug')!=TOOL or response.get('successful') is not True or response.get('error') is not None:raise ValueError('provider error')
    if (value.get('status')!='confirmed' or value.get('summary')!=event['summary']
            or instant(value['start']['dateTime'])!=instant(event['start_datetime'])
            or instant(value['end']['dateTime'])!=instant(event['end_datetime'])):
        raise ValueError('provider did not confirm the reviewed event')
    # Any missing, altered or truncated guest/series receipt is uncertain, never a retry.
    attendees,recurrence,_=options(event)
    if value.get('attendeesOmitted') is True:raise ValueError('incomplete guests')
    returned=value.get('attendees',[])
    if not isinstance(returned,list) or len(returned)>11:raise ValueError('unexpected guests')
    emails=[]
    for guest in returned:
        if not isinstance(guest,dict) or not isinstance(guest.get('email'),str):raise ValueError('guest receipt')
        email=guest['email'].casefold()
        if email not in {v.casefold() for v in attendees}:
            organizer=value.get('organizer',{})
            if not (guest.get('organizer') is True and guest.get('self') is True
                    and isinstance(organizer,dict) and organizer.get('self') is True
                    and isinstance(organizer.get('email'),str) and organizer['email'].casefold()==email):
                raise ValueError('unreviewed guest')
        else:
            if guest.get('additionalGuests',0)!=0 or guest.get('resource') is True or guest.get('optional') is True:raise ValueError('unreviewed guest properties')
            emails.append(email)
    if sorted(emails)!=sorted(v.casefold() for v in attendees):raise ValueError('guest mismatch')
    actual=value.get('recurrence',[])
    if not isinstance(actual,list) or len(actual)!=len(recurrence):raise ValueError('series mismatch')
    if recurrence:
        # Provider ordering of RRULE parts is not significant; extra parts are.
        if (not isinstance(actual[0],str) or not actual[0].startswith('RRULE:')
                or sorted(actual[0][6:].split(';'))!=sorted(recurrence[0][6:].split(';'))
                or value['start'].get('timeZone')!=event['timezone']
                or value['end'].get('timeZone')!=event['timezone']):raise ValueError('series mismatch')
    return validate_receipt({'provider':'Google Calendar','event_id':value['id'],'meaning':ACCEPTED})


@contextmanager
def prepared(config,payload,authorize,*,manager_factory=apps._manager,servers_reader=apps.saved_servers,
             clock=time.monotonic,utcnow=lambda:datetime.now(timezone.utc)):
    cancel=apps.DeadlineCancellation(clock()+30,clock=clock)
    args=arguments(payload['event'])
    def check():
        authorize()
        if cancel.is_set():raise RegistryError('cancelled','Calendar action reached its deadline before dispatch.')
        now=utcnow()
        if now.tzinfo is None or instant(payload['event']['start_datetime'])<=now:
            raise RegistryError('calendar_start_passed','The start time has passed. Review a new event; DGC will not move it automatically.')
        spec,fingerprint=apps.connection(config,payload['server']);saved=servers_reader(config).get(payload['server'])
        if (not apps.supported(spec) or fingerprint!=payload['connection_digest'] or not isinstance(saved,dict)
                or saved.get('enabled') is False or apps.digest(saved)!=fingerprint):
            raise RegistryError('connection_changed','Connection was removed or changed. Prepare a new calendar review.')
    check();manager=manager_factory(config,payload['server'],cancel)
    try:
        name,fingerprint=route(manager,payload['server'],cancel)
        if fingerprint!=payload['schema_digest']:raise RegistryError('send_schema_changed','Calendar schema changed. Prepare a new review.')
        check()
        def create():
            check()
            return result(manager.call(name,{'tools':[{'tool_slug':TOOL,'account':payload['account'],'arguments':args}],
                'sync_response_to_workbench':False,'current_step':'CREATING_HUMAN_REVIEWED_PIP_EVENT'},cancel=cancel,
                input_handler=lambda *a,**kw:{'action':'cancel'}),payload['event'])
        yield create
    finally:manager.stop_all()

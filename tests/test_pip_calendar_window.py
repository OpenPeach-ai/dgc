"""Deterministic calendar permissions and routing; no network or sleeps."""
import copy
import unittest
from datetime import datetime
from unittest.mock import Mock
from dgc import pip_calendar_window as window,pip_app_access as apps
from dgc.workspace_registry import RegistryError
from tests import test_pip_app_access as fixtures


def recipe(**kw):return {'kind':'calendar_days','timezone':'America/New_York','start_day':0,'days':1,**kw}
def instant(s):return datetime.fromisoformat(s.replace('Z','+00:00'))

class WindowTests(unittest.TestCase):
    def test_local_day_changes_at_local_midnight_not_utc(self):
        value=window.resolve(recipe(timezone='Asia/Kolkata'),instant('2026-10-03T20:00:00Z'))
        self.assertEqual(value,{'time_min':'2026-10-03T18:30:00Z','time_max':'2026-10-04T18:30:00Z'})
    def test_dst_days_have_23_and_25_hours(self):
        for now,hours in [('2026-03-08T15:00:00Z',23),('2026-11-01T15:00:00Z',25)]:
            result=window.resolve(recipe(),instant(now))
            self.assertEqual((instant(result['time_max'])-instant(result['time_min'])).total_seconds(),hours*3600)
    def test_leap_day_and_year_rollover(self):
        self.assertEqual(window.resolve(recipe(timezone='UTC',days=2),instant('2028-02-28T12:00:00Z'))['time_max'],'2028-03-01T00:00:00Z')
        self.assertEqual(window.resolve(recipe(timezone='UTC',start_day=1),instant('2026-12-31T12:00:00Z'))['time_min'],'2027-01-01T00:00:00Z')
    def test_invalid_shapes_zones_and_nonexistent_day_fail_closed(self):
        for v in [recipe(days=True),recipe(days=32),recipe(start_day=-1),recipe(timezone='../etc/passwd'),recipe(timezone='Missing/Zone'),{**recipe(),'override':'all'},recipe(kind='rolling_seconds')]:
            with self.subTest(value=v),self.assertRaises(RegistryError):window.validate(v)
        with self.assertRaises(RegistryError):window.resolve(recipe(),datetime(2026,1,1))
        with self.assertRaises(RegistryError):window.resolve(recipe(timezone='Pacific/Apia',start_day=1),instant('2011-12-29T12:00:00Z'))
    def test_stable_same_recipe_moves_with_actual_run_day(self):
        p=recipe(timezone='UTC');before=copy.deepcopy(p)
        a=window.resolve(p,instant('2026-10-03T12:00:00Z'));b=window.resolve(p,instant('2026-10-04T12:00:00Z'))
        self.assertEqual(a['time_max'],b['time_min']);self.assertEqual(p,before)

class CalendarReadTests(unittest.TestCase):
    def setUp(self):
        fixtures.MetaAppTests.setUp(self)
        self.plan['schema_version']=2
        self.plan['calls'][0].update(tool='GOOGLECALENDAR_FIND_EVENT',arguments={'calendar_id':'primary','max_results':5,'single_events':True},window=recipe(timezone='Asia/Kolkata'))
    def read(self,**kwargs):
        return apps.execute(self.cfg,self.plan,authorize=lambda:None,manager_factory=self.factory,wall_clock=lambda:instant('2026-10-03T20:00:00Z'),**kwargs)
    def test_exact_account_and_resolved_dates_with_immutable_permission(self):
        before=copy.deepcopy(self.plan);result=self.read();args=self.manager.calls[-1][1]['tools'][0]
        self.assertEqual(args['account'],'ca_test');self.assertEqual(args['tool_slug'],'GOOGLECALENDAR_FIND_EVENT')
        self.assertEqual(args['arguments']['time_min'],'2026-10-03T18:30:00Z');self.assertNotIn('window',args['arguments'])
        self.assertEqual(result[0]['calendar_window']['timezone'],'Asia/Kolkata');self.assertTrue(result[0]['untrusted']);self.assertEqual(self.plan,before)
    def test_whole_plan_resolves_once_before_connecting(self):
        self.plan['calls'].append(copy.deepcopy(self.plan['calls'][0]));clock=Mock(return_value=instant('2026-10-03T20:00:00Z'))
        apps.execute(self.cfg,self.plan,authorize=lambda:None,manager_factory=self.factory,wall_clock=clock)
        self.assertEqual(clock.call_count,1);calls=[v[1] for v in self.manager.calls if v[0]=='execute'];self.assertEqual(calls[0],calls[1])
    def test_invalid_second_window_prevents_all_provider_calls(self):
        other=copy.deepcopy(self.plan['calls'][0]);other['window']=recipe(timezone='Pacific/Apia',start_day=1);self.plan['calls'].append(other)
        factory=Mock(side_effect=AssertionError('Must resolve before connecting'))
        with self.assertRaises(RegistryError):apps.execute(self.cfg,self.plan,authorize=lambda:None,manager_factory=factory,wall_clock=lambda:instant('2011-12-29T12:00:00Z'))
        factory.assert_not_called()
    def test_old_version_fixed_overrides_email_and_missing_account_refused(self):
        variants=[]
        old=copy.deepcopy(self.plan);old['schema_version']=1;variants.append(old)
        dates=copy.deepcopy(self.plan);dates['calls'][0]['arguments']['time_min']='2020-01-01';variants.append(dates)
        mail=copy.deepcopy(self.plan);mail['calls'][0]['tool']='GMAIL_FETCH_EMAILS';variants.append(mail)
        missing=copy.deepcopy(self.plan);del missing['calls'][0]['account'];variants.append(missing)
        for value in variants:
            with self.assertRaises(RegistryError):apps.validate(value)
    def test_direct_route_cannot_silently_ignore_selected_account(self):
        self.manager=fixtures.Manager();self.manager._routes={'read':('composio','GOOGLECALENDAR_FIND_EVENT')}
        self.manager.tool_schemas=lambda:[{'function':{'name':'read','parameters':{'type':'object'}}}]
        self.plan['calls'][0]['schema_digest']=apps.digest({'type':'object'})
        with self.assertRaisesRegex(RegistryError,'cannot enforce'):self.read()
        self.assertEqual(self.manager.calls,[]);self.assertTrue(self.manager.closed)

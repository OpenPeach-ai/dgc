"""Durable reviewed and unattended Personal Pip result routing."""
import unittest
import sqlite3
import json
from unittest.mock import patch

from dgc import pip_flows, pip_handoffs, pip_chat, pip_archive, pip_purge, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
import test_pips_local as fixtures


class PipFlowTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def prepare(self, mode='reviewed'):
        self.now = '2026-11-04T08:00:00.000Z'
        self.registry.clock = lambda: self.now
        workspace = self.registry.personal()
        self.pips = [self.store.create(workspace['id'], name, goal, 'local-console', pip_type='rook')
                     for name, goal in (('Research', 'Research a topic'), ('Writer', 'Write a draft'),
                                        ('Image', 'Plan an image'))]
        self.flow = pip_flows.create(self.store, 'Daily post', [p['id'] for p in self.pips],
                                     ['Write using these research notes.', 'Plan an image for this draft.'],
                                     mode, 'local-console', self.cfg)
        self.now = '2026-11-04T08:01:00.000Z'

    def finish(self, pip, text, *, key):
        queued = self.store.enqueue(pip['id'], key, 'local-console', self.cfg)
        claimed = self.store.claim_next()
        self.assertEqual(claimed['id'], queued['id'])
        return self.store.finish(queued['id'], result={
            'text': text, 'external_actions': False, 'tools_called': 0, 'usage': {}})

    def test_reviewed_flow_waits_at_each_exact_handoff(self):
        self.prepare()
        first = self.finish(self.pips[0], 'Research result.', key='research')
        pip_flows.after_run(self.store, self.cfg, first['id'])
        pip_flows.after_run(self.store, self.cfg, first['id'])
        steps = pip_flows.get(self.store, self.flow['id'])['steps']
        self.assertEqual(steps[0]['handoff_status'], 'pending')
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]['status'], 'review')
        handoff = pip_handoffs.get(self.store, steps[0]['handoff_id'])
        self.assertEqual(handoff['status'], 'pending')
        self.assertEqual(self.store.runs(self.pips[1]['id']), [])
        second = pip_handoffs.accept(self.store, handoff['id'], 0, 'local-console', self.cfg)['run']
        self.store.claim_next()
        self.store.finish(second['id'], result={
            'text': 'Draft result.', 'external_actions': False, 'tools_called': 0, 'usage': {}})
        pip_flows.after_run(self.store, self.cfg, second['id'])
        steps = pip_flows.get(self.store, self.flow['id'])['steps']
        self.assertEqual([step['status'] for step in steps], ['review', 'review'])
        self.assertEqual(self.store.runs(self.pips[2]['id']), [])

    def test_unattended_flow_queues_only_existing_handoff_scope(self):
        self.prepare('unattended')
        first = self.finish(self.pips[0], 'Research result.', key='research')
        pip_flows.after_run(self.store, self.cfg, first['id'])
        step = pip_flows.get(self.store, self.flow['id'])['steps'][0]
        self.assertEqual(step['status'], 'queued')
        handoff = pip_handoffs.get(self.store, step['handoff_id'])
        self.assertEqual(handoff['status'], 'accepted')
        self.assertEqual(handoff['payload']['action']['external_actions'], False)
        self.assertEqual(self.store.run(handoff['run_id'])['manifest']['run_kind'], 'personal_task')

    def test_daily_start_limit_is_rolling_across_midnight(self):
        self.prepare('reviewed')
        for i in range(3):
            self.now = f'2026-11-04T23:5{i}:00.000Z'
            run = self.finish(self.pips[0], 'Research result.', key=f'research-{i}')
            pip_flows.after_run(self.store, self.cfg, run['id'])
        self.now = '2026-11-05T00:01:00.000Z'
        fourth = self.finish(self.pips[0], 'Research result.', key='research-fourth')
        pip_flows.after_run(self.store, self.cfg, fourth['id'])
        latest = pip_flows.get(self.store, self.flow['id'])['steps'][0]
        self.assertEqual(latest['status'], 'paused')
        self.assertEqual(latest['reason'], 'Daily workflow run limit reached.')
        self.assertIsNone(latest['handoff_id'])

    def test_pause_closes_a_pending_reviewed_handoff(self):
        self.prepare()
        first = self.finish(self.pips[0], 'Research result.', key='research')
        pip_flows.after_run(self.store, self.cfg, first['id'])
        step = pip_flows.get(self.store, self.flow['id'])['steps'][0]
        pip_flows.set_status(self.store, self.flow['id'], 0, 'paused', 'local-console', self.cfg)
        with self.assertRaisesRegex(RegistryError, 'paused or changed'):
            pip_handoffs.accept(self.store, step['handoff_id'], 0, 'local-console', self.cfg)
        self.assertEqual(self.store.runs(self.pips[1]['id']), [])

    def test_scheduled_routine_reply_can_start_the_flow(self):
        self.prepare('unattended')
        queued = pip_chat.send(self.store, self.pips[0]['id'],
                               'This message is from DGC. Your morning research routine is due.',
                               'routine_0123456789abcdef_0123456789abcdef01234567',
                               'local-routine', self.cfg, _intro=True)['run']
        self.store.claim_next()
        self.store.finish(queued['id'], result={'text': 'Today’s market research.', 'usage': {}, 'tools_called': 0})
        pip_flows.after_run(self.store, self.cfg, queued['id'])
        step = pip_flows.get(self.store, self.flow['id'])['steps'][0]
        self.assertEqual(step['status'], 'queued')
        self.assertEqual(pip_handoffs.get(self.store, step['handoff_id'])['payload']['source']['text'],
                         'Today’s market research.')

    def test_pause_prevents_dispatch_and_resume_cannot_silently_take_changed_job(self):
        self.prepare('unattended')
        pip_flows.set_status(self.store, self.flow['id'], 0, 'paused', 'local-console', self.cfg)
        first = self.finish(self.pips[0], 'Research result.', key='research')
        pip_flows.after_run(self.store, self.cfg, first['id'])
        self.assertEqual(pip_flows.get(self.store, self.flow['id'])['steps'], [])
        self.assertEqual(self.store.runs(self.pips[1]['id']), [])
        with self.assertRaisesRegex(RegistryError, 'Refresh'):
            pip_flows.set_status(self.store, self.flow['id'], 0, 'on', 'local-console', self.cfg)

    def test_long_result_pauses_without_truncating_or_starting_another_pip(self):
        self.prepare('unattended')
        first = self.finish(self.pips[0], 'x' * 12001, key='research')
        pip_flows.after_run(self.store, self.cfg, first['id'])
        step = pip_flows.get(self.store, self.flow['id'])['steps'][0]
        self.assertEqual(step['status'], 'paused')
        self.assertIsNone(step['handoff_id'])
        self.assertEqual(self.store.runs(self.pips[1]['id']), [])

    def test_remote_client_cannot_create_or_unpause_a_flow(self):
        self.prepare()
        with self.assertRaisesRegex(RegistryError, 'Only you'):
            pip_flows.create(self.store, 'Other', [p['id'] for p in self.pips[:2]],
                             ['Do the next thing.'], 'unattended', 'remote-user', self.cfg)
        with self.assertRaisesRegex(RegistryError, 'Only you'):
            pip_flows.set_status(self.store, self.flow['id'], 0, 'paused', 'remote-user', self.cfg)

    def test_control_protocol_exposes_reviewed_flow_and_rejects_remote_management(self):
        self.prepare()
        workspace=self.registry.personal()['id']
        def control(actor,command,**fields):
            with patch.object(pips,'WorkspaceRegistry',lambda *a,**kw: WorkspaceRegistry(self.registry.directory)):
                return pips.handle_control(self.cfg,{'type':command,'request_id':'flow-test',**fields},actor,start_worker=False)
        listed=control('editor-user','list_pip_flows',workspace_id=workspace)
        self.assertTrue(listed['ok'])
        self.assertEqual([flow['id'] for flow in listed['result']['flows']],[self.flow['id']])
        self.assertEqual(control('remote-user','list_pip_flows',workspace_id=workspace)['error']['code'],'local_only')
        paused=control('editor-user','set_pip_flow',flow_id=self.flow['id'],expected_revision=0,status='paused')
        self.assertTrue(paused['ok'])
        self.assertEqual(paused['result']['flow']['status'],'paused')

    def test_permanent_pip_deletion_erases_its_workflow_and_events(self):
        self.prepare()
        pip = self.store.get(self.pips[1]['id'])
        archived = pip_archive.transition(self.store, pip['id'], archived=True,
            expected_version=pip['current_version'], expected_lifecycle_revision=pip['lifecycle_revision'],
            request_key='flow-purge', reason='Delete this Pip', actor='editor-user')['pip']
        pip_purge.delete(self.store, archived['id'], expected_name=archived['name'],
                         expected_version=archived['current_version'],
                         expected_lifecycle_revision=archived['lifecycle_revision'], actor='editor-user')
        self.assertIsNone(self.store.db.execute('SELECT 1 FROM pip_flows WHERE id=?', (self.flow['id'],)).fetchone())
        self.assertIsNone(self.store.db.execute('SELECT 1 FROM workspace_events WHERE instr(payload,?)>0',
                                               (self.flow['id'],)).fetchone())

    def test_restart_replays_a_finished_source_only_once(self):
        self.prepare('unattended')
        first = self.finish(self.pips[0], 'Research result.', key='research')
        pip_flows.recover(self.store, self.cfg)
        pip_flows.recover(self.store, self.cfg)
        self.assertEqual(len(pip_flows.get(self.store, self.flow['id'])['steps']), 1)
        self.assertEqual(len(self.store.runs(self.pips[1]['id'])), 1)

    def test_schema_48_upgrade_is_additive_and_atomic(self):
        self.registry.db.execute('DROP TABLE pip_flow_steps')
        self.registry.db.execute('DROP TABLE pip_flows')
        self.registry.db.execute('PRAGMA user_version=48')
        before=[tuple(row) for row in self.registry.db.execute('SELECT id,name FROM workspaces ORDER BY id')]
        with patch.object(pip_flows, 'SCHEMA', pip_flows.SCHEMA+'\nBROKEN MIGRATION;'), \
                self.assertRaises(sqlite3.OperationalError):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0],48)
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM sqlite_master WHERE name='pip_flows'").fetchone())
        with WorkspaceRegistry(self.registry.directory) as upgraded:
            self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0],50)
            self.assertEqual([tuple(row) for row in upgraded.db.execute('SELECT id,name FROM workspaces ORDER BY id')],before)
            self.assertEqual(upgraded.db.execute('SELECT count(*) FROM pip_flows').fetchone()[0],0)
            self.assertEqual(upgraded.db.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_project_workflow_routes_only_the_first_checked_finding_to_a_reader(self):
        self.commit()
        self.now='2026-11-04T08:00:00.000Z'
        self.registry.clock=lambda:self.now
        source=self.store.create(self.workspace['id'],'Reviewer','Review committed source','local-console',pip_type='rook')
        target=self.store.create(self.workspace['id'],'Researcher','Investigate the finding','local-console',pip_type='lens')
        flow=pip_flows.create(self.store,'Review chain',[source['id'],target['id']],
                              ['Check the top source finding.'],'unattended','local-console',self.cfg)
        self.assertEqual(flow['definition']['kind'],'project')
        self.now='2026-11-04T08:01:00.000Z'
        chat=pip_chat.send(self.store,source['id'],'Hi','project-chat','local-console',self.cfg)['run']
        self.store.claim_next()
        self.store.finish(chat['id'],result={'text':'Hello','usage':{},'tools_called':0})
        pip_flows.after_run(self.store,self.cfg,chat['id'])
        self.assertEqual(pip_flows.get(self.store,flow['id'])['steps'],[])
        run=self.store.enqueue(source['id'],'project-review','local-console',self.cfg)
        self.store.claim_next()
        report=pips.validate_report(json.dumps({'summary':'Reviewed source','findings':[
            {'title':'Assess return value','severity':'low','path':'source.py','line':2,
             'evidence':"    return 'hello'"}], 'limitations':['Source only']}),self.root,read_calls=1)
        done=self.store.finish(run['id'],result=report)
        pip_flows.after_run(self.store,self.cfg,done['id'])
        step=pip_flows.get(self.store,flow['id'])['steps'][0]
        self.assertEqual(step['status'],'queued')
        handoff=pip_handoffs.get(self.store,step['handoff_id'])
        self.assertEqual(handoff['payload']['type'],'audit_finding.v1')
        self.assertEqual(handoff['payload']['action'],{'kind':'read_only'})
        self.assertEqual(handoff['payload']['source']['finding_index'],0)
        self.assertEqual(self.store.run(handoff['run_id'])['pip_id'],target['id'])

    def test_project_workflow_refuses_execution_pips(self):
        self.commit()
        source=self.store.create(self.workspace['id'],'Reviewer','Review committed source','local-console',pip_type='rook')
        patcher=self.store.create(self.workspace['id'],'Fixer','Fix a file','local-console',pip_type='patch')
        with self.assertRaisesRegex(RegistryError,'read-only Pips'):
            pip_flows.create(self.store,'Unsafe route',[source['id'],patcher['id']],
                             ['Fix the finding.'],'unattended','local-console',self.cfg)


if __name__ == '__main__':
    unittest.main()

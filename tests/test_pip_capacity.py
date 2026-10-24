"""Local retained counters; disposable schema22 registries and no source scans."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

from dgc import pip_capacity as capacity, pip_cli as cli, pip_export, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests.test_pips_local import config


@unittest.skipUnless(os.name == 'posix' and hasattr(os, 'O_NOFOLLOW')
                     and (Path('/proc/self/fd').is_dir() or sys.platform == 'darwin'),
                     'Existing export opener requires Linux procfs or macOS, with POSIX no-follow support.')
class CapacityTests(unittest.TestCase):
    def setUp(self):
        # The pressure arithmetic is the same at any ceiling; 1,000-row ceilings keep the
        # fixtures to hundreds of rows instead of the shipped 20,000.
        for name in ('dgc.pips.MAX_RUNS', 'dgc.pip_checkpoints.MAX_CHECKPOINTS'):
            ceiling = patch(name, 1000)
            ceiling.start(); self.addCleanup(ceiling.stop)
        self.temp = tempfile.TemporaryDirectory(prefix='capacity-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'workspace'; self.root.mkdir()
        self.foreign = self.base / 'foreign'; self.foreign.mkdir()
        self.registry = WorkspaceRegistry(self.base / 'state', clock=lambda: '2026-10-02T10:00:00.000Z')
        self.addCleanup(self.registry.close)
        self.workspace = self.registry.resolve(self.root)
        self.other = self.registry.resolve(self.foreign)
        self.store = pips.PipStore(self.registry)
        self.jobs = {item['id']: self.store.create(item['id'], 'PRIVATE JOB NAME', 'PRIVATE JOB PROSE', 'fixture')
                     for item in (self.workspace, self.other)}
        for item in (self.workspace, self.other):
            self.registry.db.execute('INSERT INTO session_workspaces VALUES(?,?,?,?)',
                ('session_' + item['id'], item['id'], item['binding_id'], '2026-10-02T10:00:00.000Z'))
        self.cfg = config(self.root, pips_enabled=False)
        self.serial = 0
        deny_network = patch('requests.sessions.Session.request', side_effect=AssertionError('No network'))
        deny_network.start(); self.addCleanup(deny_network.stop)

    def add(self, kind, count=1, *, workspace=None, status='failed', payload='PRIVATE UNDECODED BODY'):
        ws = workspace or self.workspace
        pip = self.jobs[ws['id']]['id']
        ids = []
        for _ in range(count):
            self.serial += 1
            identity = f'{self.serial:032x}'
            if kind == 'runs':
                ident = 'run_' + identity
                self.registry.db.execute('''INSERT INTO pip_runs
                    (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?)''', (ident,pip,ws['id'],ws['binding_id'],identity,'fixture',payload,status,'2026-10-02T10:00:00.000Z'))
            elif kind == 'checkpoints':
                run = self.add('runs', workspace=ws)[0]
                ident = self.registry.db.execute('INSERT INTO pip_checkpoints(run_id,pip_id,workspace_id,payload) VALUES(?,?,?,?)',
                    (run,pip,ws['id'],'{}')).lastrowid
            elif kind == 'exceptions':
                run = self.add('runs', workspace=ws)[0]
                ident = 'memory_' + identity
                self.registry.db.execute('''INSERT INTO pip_memories
                    (id,pip_id,workspace_id,source_run_id,source_finding_index,request_key_digest,request_digest,payload,digest)
                    VALUES(?,?,?,?,?,?,?,?,?)''', (ident,pip,ws['id'],run,0,identity,'a'*64,'{}','b'*64))
            elif kind == 'statements':
                ident = 'statement_' + identity
                self.registry.db.execute('''INSERT INTO pip_memory_statements
                    (id,pip_id,workspace_id,kind,request_key_digest,request_digest,payload,digest)
                    VALUES(?,?,?,?,?,?,?,?)''', (ident,pip,ws['id'],'fact',identity,'a'*64,'{}','b'*64))
            elif kind == 'session_statements':
                ident = 'outcome_' + identity
                self.registry.db.execute('''INSERT INTO workspace_session_outcomes
                    (id,workspace_id,session_id,request_key,request_digest,binding_pin,payload,digest,status,reviewed_at,reviewed_by)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)''', (ident,ws['id'],'session_'+ws['id'],identity,'a'*64,'{}',payload,'b'*64,
                    'rejected','2026-10-02T10:00:00.000Z','fixture'))
            else:
                raise AssertionError(kind)
            ids.append(ident)
        return ids

    def inspect(self):
        return capacity.inspect_capacity(self.cfg, directory=self.registry.directory)['capacity_inspection']

    def rows(self):
        return {row['kind']: row for row in self.inspect()['capacity']}

    def count(self, value):
        return {'value': value, 'relation': 'exact', 'reason': None}

    def fingerprint(self):
        digest = hashlib.sha256()
        for line in self.registry.db.iterdump(): digest.update(line.encode())
        return digest.hexdigest()

    @contextlib.contextmanager
    def late_fetch(self, fragment):
        """Expire after a real cursor fetch, before the budget accepts its data."""
        original = capacity._Budget.execute
        observed = {'fetched': 0, 'closed': 0}
        def execute(budget, db, sql, parameters=()):
            cursor = original(budget, db, sql, parameters)
            if fragment not in sql:
                return cursor
            class LateCursor:
                def fetchone(self):
                    value = cursor.fetchone()
                    observed['fetched'] += 1
                    budget.deadline = 0
                    return value
                def fetchall(self):
                    value = cursor.fetchall()
                    observed['fetched'] += 1
                    budget.deadline = 0
                    return value
                def close(self):
                    observed['closed'] += 1
                    cursor.close()
            return LateCursor()
        with patch.object(capacity._Budget, 'execute', execute):
            yield observed

    def test_empty_disabled_history_has_four_global_ceiling_rows_and_no_writes(self):
        before = self.fingerprint(); changes = self.registry.db.total_changes
        value = self.inspect()
        self.assertEqual([r['kind'] for r in value['capacity']], list(capacity.KINDS))
        for row in value['capacity']:
            self.assertEqual((row['ceiling'],row['ceiling_scope']), (1000,'local_runner'))
            self.assertEqual(row['retained'],self.count(0));self.assertEqual(row['workspace_retained'],self.count(0))
            self.assertEqual((row['remaining_slots'],row['pressure']),(1000,'normal'))
        self.assertEqual(value['scope'],{'kind':'local_runner_with_workspace','workspace_id':self.workspace['id']})
        self.assertFalse(value['partial']); self.assertEqual(self.fingerprint(),before)
        self.assertEqual(self.registry.db.total_changes,changes)
        self.assertFalse(self.cfg.get('pips_enabled'))

    def test_global_counts_include_other_workspaces_without_their_id_or_prose(self):
        self.add('runs',3);self.add('runs',4,workspace=self.other)
        self.add('checkpoints');self.add('checkpoints',2,workspace=self.other)
        self.add('statements',2);self.add('statements',3,workspace=self.other)
        self.add('session_statements',4);self.add('session_statements',5,workspace=self.other)
        value=self.inspect();rows={r['kind']:r for r in value['capacity']}
        self.assertEqual(rows['runs']['retained'],self.count(10));self.assertEqual(rows['runs']['workspace_retained'],self.count(4))
        for kind, total, local in (('checkpoints',3,1),('pip_memory',5,2),('session_statements',9,4)):
            self.assertEqual(rows[kind]['retained'],self.count(total));self.assertEqual(rows[kind]['workspace_retained'],self.count(local))
        raw=json.dumps(value)
        for secret in (self.other['id'],str(self.foreign),'PRIVATE','source_run_id','model','canonical_root'):
            self.assertNotIn(secret,raw)

    def test_combined_memory_saturates_total_not_independent_ledgers(self):
        self.add('exceptions',600);self.add('statements',401,workspace=self.other)
        row=self.rows()['pip_memory']
        self.assertEqual(row['retained'],{'value':1001,'relation':'at_least','reason':None})
        self.assertEqual(row['workspace_retained'],self.count(600))
        self.assertIsNone(row['remaining_slots']);self.assertEqual(row['pressure'],'over_limit')

    def test_archived_failed_cancelled_expired_and_revoked_history_still_counts(self):
        self.add('runs',status='failed');self.add('runs',status='cancelled')
        self.add('runs',status='waiting');self.add('statements',2)
        self.registry.db.execute("UPDATE pips SET status='archived' WHERE id=?",(self.jobs[self.workspace['id']]['id'],))
        self.registry.db.execute("UPDATE pip_memory_statements SET status='revoked',revision=1,revoked_at='2026-10-02T09:00:00.000Z',revoked_by='user',revoke_reason='fixture' WHERE seq=1")
        self.registry.db.execute('DROP TRIGGER immutable_pip_statement')
        self.registry.db.execute("UPDATE pip_memory_statements SET expires_at='2026-10-01T00:00:00.000Z' WHERE seq=2")
        rows=self.rows();self.assertEqual(rows['runs']['retained'],self.count(3))
        self.assertEqual(rows['pip_memory']['retained'],self.count(2))

    def test_exact_warning_full_and_over_limit_do_not_create_fake_remaining(self):
        self.add('runs',799)
        self.assertEqual(self.rows()['runs']['pressure'],'normal')
        self.add('runs');self.assertEqual(self.rows()['runs']['pressure'],'near_limit')
        self.add('runs',200);row=self.rows()['runs']
        self.assertEqual((row['retained'],row['remaining_slots'],row['pressure']),(self.count(1000),0,'full'))
        self.add('runs',50);row=self.rows()['runs']
        self.assertEqual(row['retained']['value'],1001);self.assertIsNone(row['remaining_slots'])
        self.assertTrue(self.inspect()['partial'])

    def test_session_statement_ceiling_is_global(self):
        self.add('session_statements',2);self.add('session_statements',999,workspace=self.other)
        row=self.rows()['session_statements']
        self.assertEqual(row['retained']['relation'],'at_least');self.assertEqual(row['workspace_retained'],self.count(2))

    def test_no_body_decode_source_artifact_or_registry_constructor(self):
        self.add('runs',payload='x'*(2*1024*1024));self.add('session_statements',payload='x'*(2*1024*1024))
        with patch.object(WorkspaceRegistry,'__init__',side_effect=AssertionError('No registry construction')), \
             patch('builtins.open',side_effect=AssertionError('No source/artifact/config open')), \
             patch.object(json,'loads',side_effect=AssertionError('No payload decode')), \
             patch.object(Path,'resolve',side_effect=AssertionError('No source resolution')):
            rows=self.rows()
        self.assertEqual(rows['runs']['retained'],self.count(1));self.assertEqual(rows['session_statements']['retained'],self.count(1))

    def test_offline_registered_root_works_without_filesystem_lookup(self):
        self.root.rmdir()
        self.assertEqual(self.inspect()['scope']['workspace_id'],self.workspace['id'])

    def test_unregistered_scope_fails_before_capacity_counts(self):
        self.cfg.project_root=self.base/'unregistered'
        with patch.object(capacity,'_count',side_effect=AssertionError('Scope first')):
            with self.assertRaises(RegistryError) as caught:self.inspect()
        self.assertEqual(caught.exception.code,'not_found');self.assertFalse(self.cfg.project_root.exists())

    def test_malformed_and_oversized_runner_identity_refuses_before_counting(self):
        for value in ('runner_bad','x'*(2*1024*1024),'runner_'+'a'*32+'\n'):
            self.registry.db.execute("UPDATE metadata SET value=? WHERE key='runner_id'",(value,))
            with patch.object(capacity,'_count',side_effect=AssertionError('Scope first')),self.assertRaises(RegistryError):self.inspect()

    def test_invalid_root_metadata_does_not_open_database(self):
        for value in ('relative/path','/tmp/../root','/tmp/\x00bad','/tmp/'+'x'*5000,'/tmp/\ud800'):
            self.cfg.project_root=value
            with patch.object(capacity,'_read_database',side_effect=AssertionError('No database open')),self.assertRaises(RegistryError):self.inspect()

    def test_runtime_policy_and_sandbox_gate_before_any_registry_open(self):
        for target in ('dgc.permissions.session_policy','dgc.sandbox.requested'):
            with patch(target,return_value=True),patch.object(capacity,'_read_database',side_effect=AssertionError('Unauthorized database open')):
                with self.assertRaises(RegistryError) as caught:self.inspect()
            self.assertEqual(caught.exception.code,'session_policy')

    def test_missing_database_is_not_initialized_without_creation(self):
        missing=self.base/'missing'
        with self.assertRaises(RegistryError) as caught:capacity.inspect_capacity(self.cfg,directory=missing)
        self.assertEqual(caught.exception.code,'not_initialized');self.assertFalse(missing.exists())

    def test_old_schema_refuses_without_migration(self):
        self.registry.db.execute('PRAGMA user_version=21')
        with self.assertRaises(RegistryError) as caught:self.inspect()
        self.assertEqual(caught.exception.code,'schema_version')
        self.assertIn('Capacity inspection',str(caught.exception))
        self.assertNotIn('export',str(caught.exception).lower())
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0],21)

    def test_shared_query_budget_preserves_completed_count_but_not_unknown_zero(self):
        self.add('runs',3)
        with patch.object(capacity,'MAX_QUERIES',4):value=self.inspect()
        row=value['capacity'][0]
        self.assertEqual(row['retained'],self.count(3))
        self.assertEqual(row['workspace_retained'],{'value':None,'relation':'unknown','reason':'query_budget'})
        self.assertEqual(row['remaining_slots'],997);self.assertTrue(value['partial'])
        for later in value['capacity'][1:]:
            self.assertEqual(later['retained']['relation'],'unknown');self.assertIsNone(later['remaining_slots'])

    def test_shared_deadline_stops_later_queries_without_sleep(self):
        original=capacity._count
        def first(*args):
            answer=original(*args)
            args[-1].deadline=0
            return answer
        with patch.object(capacity,'_count',side_effect=first):value=self.inspect()
        self.assertEqual(value['capacity'][0]['retained'],self.count(0))
        self.assertEqual(value['capacity'][0]['workspace_retained']['reason'],'deadline')
        self.assertTrue(value['partial'])

    def test_count_fetched_after_deadline_is_unknown_and_closes_cursor(self):
        self.add('runs',7)
        before = self.fingerprint()
        with self.late_fetch('SELECT count(*)') as observed:
            value = self.inspect()
        self.assertEqual(observed, {'fetched': 1, 'closed': 1})
        for row in value['capacity']:
            for field in ('retained', 'workspace_retained'):
                self.assertEqual(row[field], {'value': None, 'relation': 'unknown', 'reason': 'deadline'})
            self.assertIsNone(row['remaining_slots'])
        self.assertTrue(value['partial'])
        self.assertEqual(self.fingerprint(), before)

    def test_schema_fetched_after_deadline_refuses_before_scope_and_clears_handler(self):
        before = self.fingerprint()
        with self.late_fetch('PRAGMA user_version') as observed, \
             patch.object(capacity, '_scope', side_effect=AssertionError('Schema first')), \
             self.assertRaises(RegistryError) as caught:
            self.inspect()
        self.assertEqual(caught.exception.code, 'capacity_scope_unavailable')
        self.assertEqual(observed, {'fetched': 1, 'closed': 1})
        self.assertEqual(self.fingerprint(), before)
        self.assertFalse(self.inspect()['partial'])

    def test_scope_fetched_after_deadline_never_exposes_global_counts(self):
        before = self.fingerprint()
        for fragment in ('FROM metadata', 'FROM bindings'):
            with self.subTest(fragment=fragment), self.late_fetch(fragment) as observed, \
                 patch.object(capacity, '_count', side_effect=AssertionError('Scope first')), \
                 self.assertRaises(RegistryError) as caught:
                self.inspect()
            self.assertEqual(caught.exception.code, 'capacity_scope_unavailable')
            self.assertEqual(observed, {'fetched': 1, 'closed': 1})
        self.assertEqual(self.fingerprint(), before)
        self.assertFalse(self.inspect()['partial'])

    def test_short_queries_consume_conservative_tail_budget_before_dispatch(self):
        # Every SELECT is far below a real callback quantum, including their
        # combined work. Reservations must still exhaust the shared VM budget.
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        statements = []
        callbacks = []
        db.set_trace_callback(statements.append)
        with patch.object(capacity, 'MAX_VM_INSTRUCTIONS', 5 * capacity.PROGRESS_INTERVAL):
            budget = capacity._Budget()
            def progress():
                callbacks.append(True)
                return budget.progress()
            db.set_progress_handler(progress, capacity.PROGRESS_INTERVAL)
            try:
                for _ in range(4):
                    self.assertEqual(budget.fetchone(db, 'SELECT 1'), (1,))
                with self.assertRaises(capacity._BudgetExceeded):
                    budget.fetchone(db, 'SELECT 1')
                self.assertEqual(budget.reason, 'vm_budget')
                self.assertEqual(budget.queries, 4)
                self.assertEqual(budget.instructions, 5 * capacity.PROGRESS_INTERVAL)
                self.assertEqual(len(statements), 4)
                self.assertEqual(callbacks, [])
            finally:
                db.set_progress_handler(None, 0)

    def test_real_sqlite_progress_interrupt_is_reported_unknown(self):
        self.add('runs',500)
        original=capacity._count
        def count(db,kind,ceiling,workspace,budget):
            # Scope is established first. Exercise the actual SQLite callback
            # on the count statement; no elapsed sleeps or synthetic result.
            budget.instructions=capacity.MAX_VM_INSTRUCTIONS - 2 * capacity.PROGRESS_INTERVAL
            return original(db,kind,ceiling,workspace,budget)
        with patch.object(capacity,'PROGRESS_INTERVAL',1),patch.object(capacity,'_count',side_effect=count):
            value=self.inspect()
        self.assertEqual(value['capacity'][0]['retained'],{'value':None,'relation':'unknown','reason':'vm_budget'})
        self.assertTrue(value['partial'])

    def test_scope_budget_exhaustion_returns_no_foreign_global_totals(self):
        with patch.object(capacity,'MAX_QUERIES',1),self.assertRaises(RegistryError) as caught:self.inspect()
        self.assertEqual(caught.exception.code,'capacity_scope_unavailable')

    def test_scope_vm_interrupt_keeps_original_refusal_during_cleanup(self):
        before=self.fingerprint()
        with patch.object(capacity,'PROGRESS_INTERVAL',1),patch.object(capacity,'MAX_VM_INSTRUCTIONS',3):
            with self.assertRaises(RegistryError) as caught:self.inspect()
        self.assertEqual(caught.exception.code,'capacity_scope_unavailable')
        self.assertEqual(self.fingerprint(),before)

    def test_corrupt_missing_capacity_table_is_unknown_not_zero(self):
        self.registry.db.execute('DROP TABLE workspace_session_outcomes')
        row=self.rows()['session_statements']
        self.assertEqual(row['retained'],{'value':None,'relation':'unknown','reason':'invalid_stored_metadata'})
        self.assertIsNone(row['remaining_slots'])

    def test_one_read_snapshot_survives_concurrent_writer(self):
        second=WorkspaceRegistry(self.registry.directory);self.addCleanup(second.close)
        original=capacity._count;changed=False
        def count(*args):
            nonlocal changed
            value=original(*args)
            if not changed:
                changed=True
                second.db.execute('''INSERT INTO pip_runs(id,pip_id,workspace_id,binding_id,idempotency_key,
                    requested_by,manifest,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)''',
                    ('run_'+'f'*32,self.jobs[self.workspace['id']]['id'],self.workspace['id'],self.workspace['binding_id'],
                     'race','fixture','{}','failed','2026-10-02T10:00:00.000Z'))
            return value
        with patch.object(capacity,'_count',side_effect=count):value=self.inspect()
        self.assertEqual(value['capacity'][0]['retained'],self.count(0))
        self.assertEqual(value['capacity'][0]['workspace_retained'],self.count(0))
        self.assertEqual(self.rows()['runs']['retained'],self.count(1))

    def test_reader_uses_query_only_and_never_mutates(self):
        original=capacity._read_database;statements=[]
        @contextlib.contextmanager
        def opened(directory):
            with original(directory) as db:
                self.assertEqual(db.execute('PRAGMA query_only').fetchone()[0],1)
                db.set_trace_callback(statements.append)
                yield db
                self.assertEqual(db.total_changes,0)
        before=self.fingerprint()
        with patch.object(capacity,'_read_database',opened):self.inspect()
        self.assertEqual(self.fingerprint(),before)
        self.assertFalse(any(sql.lstrip().upper().startswith(('INSERT','UPDATE','DELETE','CREATE','ALTER','VACUUM')) for sql in statements))
        self.assertFalse(any('SELECT *' in sql.upper() for sql in statements))

    def test_secret_metadata_collision_and_output_budget_fail_closed(self):
        with patch.object(capacity,'secret_values',return_value=(self.workspace['id'],)),self.assertRaises(RegistryError) as caught:self.inspect()
        self.assertEqual(caught.exception.code,'secret_detected')
        with patch.object(capacity,'MAX_OUTPUT_BYTES',10),self.assertRaises(RegistryError) as caught:self.inspect()
        self.assertEqual(caught.exception.code,'capacity_output_limit')

    def test_existing_opener_rejects_symlink_and_unsafe_registry(self):
        link=self.base/'linked';link.symlink_to(self.registry.directory,target_is_directory=True)
        with self.assertRaises((RegistryError,OSError)):capacity.inspect_capacity(self.cfg,directory=link)
        self.registry.directory.chmod(0o755)
        with self.assertRaises(RegistryError):self.inspect()
        self.registry.directory.chmod(0o700)

    def test_existing_opener_unsupported_platform_has_no_fallback(self):
        # Only the opener sees Windows: patching the shared os module would also make every Path() a WindowsPath,
        # which Python 3.10 and 3.11 refuse to create on a POSIX host.
        windows=SimpleNamespace(**{**vars(os),'name':'nt'})
        with patch.object(pip_export,'os',windows),self.assertRaises(RegistryError) as caught:self.inspect()
        self.assertEqual(caught.exception.code,'unsupported_platform')
        self.assertIn('capacity inspection',str(caught.exception))
        self.assertNotIn('export',str(caught.exception).lower())

    def test_cli_runs_early_when_disabled_without_controller_or_startup(self):
        before=self.fingerprint()
        for args in (['capacity'],['capacity','--json'],['--json','capacity']):
            output=io.StringIO()
            with patch.object(capacity,'state_directory',return_value=self.registry.directory), \
                 patch.object(pips,'handle_control',side_effect=AssertionError('No controller call')), \
                 patch.object(cli,'WorkspaceRegistry',side_effect=AssertionError('No state constructor')), \
                 patch('dgc.pip_daemon.serve',side_effect=AssertionError('No runner')),contextlib.redirect_stdout(output):
                self.assertEqual(cli.handle_command(self.cfg,args),0)
            if '--json' in args:self.assertIn('capacity_inspection',json.loads(output.getvalue()))
            else:self.assertIn('across this runner',output.getvalue())
        self.assertEqual(self.fingerprint(),before)

    def test_cli_refuses_chat_and_extra_scope_run_or_mutation_flags(self):
        with patch.object(capacity,'inspect_capacity',side_effect=AssertionError('No read')), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertNotEqual(cli.handle_command(self.cfg,['capacity'],in_chat=True),0)
            for args in (['--run','run_'+'a'*32],['--workspace',self.other['id']],['--apply'],['--output','/tmp/no']):
                self.assertEqual(cli.handle_command(self.cfg,['capacity',*args]),2)


if __name__ == '__main__':
    unittest.main()

"""Pending statement indices expose routes, not private statement/transcript prose."""
import json
import unittest
from unittest.mock import patch

from dgc import pip_handoffs, pip_overview as overview, pips, workspace_session_outcomes as outcomes
from dgc.workspace_registry import RegistryError
from tests import test_workspace_session_outcomes as fixtures
from tests import test_pips_local as local


class SessionOutcomeOverviewTests(unittest.TestCase):
    setUp = fixtures.SessionOutcomeTests.setUp
    git = local.LocalPipsTests.git
    commit = local.LocalPipsTests.commit
    write = fixtures.SessionOutcomeTests.write
    propose = fixtures.SessionOutcomeTests.propose
    accept = fixtures.SessionOutcomeTests.accept

    def job(self):
        return self.store.create(self.ws, 'Source reviewer', 'Inspect source', 'user')

    def approval(self, job, name='Updated'):
        return self.store.propose(job['id'], job['current_version'], {'name': name}, 'user')

    def handoff(self):
        source, target = self.job(), self.job()
        run = self.store.enqueue(source['id'], 'source-review', 'user', self.cfg)
        self.store.claim_next()
        report = pips.validate_report(json.dumps({'summary': 'Reviewed source', 'findings': [
            {'title': 'Assess return value', 'severity': 'low', 'path': 'source.py', 'line': 2,
             'evidence': "    return 'hello'"}], 'limitations': ['Source only']}), self.root, read_calls=1)
        self.store.finish(run['id'], result=report)
        return pip_handoffs.propose(self.store, source_run_id=run['id'], finding_index=0, target_pip_id=target['id'],
            task='Private handoff task', action={'kind': 'read_only'}, idempotency_key='handoff', actor='user', config=self.cfg)

    def test_mixed_pages_preserve_old_rows_and_cursor_order(self):
        job = self.job(); self.approval(job); self.handoff()
        before = overview.pending_reviews(self.registry)['reviews']
        self.assertEqual({row['kind'] for row in before}, {'job_update', 'handoff'})
        self.propose(request_key='statement-1'); self.propose(request_key='statement-2')
        expected = overview.pending_reviews(self.registry)['reviews']
        self.assertEqual([row for row in expected if row['kind'] != 'session_outcome'], before)
        seen, cursor = [], None
        while True:
            page = overview.pending_reviews(self.registry, before_id=cursor, limit=1)
            seen.extend(page['reviews'])
            self.assertEqual(page['total_pending'], 4)
            if not page['has_more']:
                self.assertIsNone(page['next_before_id']); break
            cursor = page['next_before_id']
        self.assertEqual(seen, expected)
        self.assertEqual([(r['created_at'], r['id']) for r in seen], sorted([(r['created_at'], r['id']) for r in seen], reverse=True))
        self.assertEqual(len({r['id'] for r in seen}), 4)

    def test_index_contains_static_summary_and_only_exact_review_route(self):
        proposal = self.propose(title='PRIVATE_TITLE', statement='PRIVATE_STATEMENT')
        before = self.registry.db.total_changes
        page = overview.pending_reviews(self.registry)
        self.assertEqual(page['reviews'], [{'id': 'session_outcome:' + proposal['id'], 'workspace_id': self.ws,
            'pip_id': None, 'created_at': proposal['created_at'], 'expires_at': None, 'kind': 'session_outcome',
            'summary': overview.SESSION_STATEMENT_SUMMARY, 'reference': {'proposal_id': proposal['id']}}])
        raw = json.dumps(page)
        for secret in ('PRIVATE_TITLE', 'PRIVATE_STATEMENT', 'PRIVATE_TRANSCRIPT', str(self.root), self.sid, self.revision):
            self.assertNotIn(secret, raw)
        self.assertEqual(self.registry.db.total_changes, before)

    def test_counts_include_statements_exclude_resolved_and_keep_expiry_semantics(self):
        job = self.job(); self.approval(job)
        self.store.propose(job['id'], 1, {'schedule': {'type': 'interval', 'minutes': 10, 'missed_policy': 'coalesce_latest'}}, 'user')
        accepted = self.propose(request_key='accept'); rejected = self.propose(request_key='reject'); pending = self.propose(request_key='pending')
        def counts():
            return next(row for row in overview.workspace_overviews(self.registry)['workspaces'] if row['id'] == self.ws)['counts']
        self.assertEqual((counts()['reviews_session_outcome'], counts()['reviews_total']), (3, 5))
        self.accept(accepted)
        self.outcomes.reject(self.ws, rejected['id'], rejected['digest'], 'user')
        self.assertEqual((counts()['reviews_session_outcome'], counts()['reviews_total']), (1, 3))
        self.registry.clock = lambda: '2026-11-01T10:00:00.000Z'
        self.assertEqual((counts()['reviews_session_outcome'], counts()['reviews_total']), (1, 1))
        self.assertEqual(overview.pending_reviews(self.registry)['reviews'][0]['reference']['proposal_id'], pending['id'])

    def test_resolved_statement_cursor_continues_and_wrong_scope_is_refused(self):
        self.approval(self.job()); self.propose(request_key='first'); self.propose(request_key='second')
        first = overview.pending_reviews(self.registry, limit=1)
        row = first['reviews'][0]; self.assertEqual(row['kind'], 'session_outcome')
        proposal = self.outcomes.get(self.ws, row['reference']['proposal_id'])['proposal']
        self.outcomes.reject(self.ws, proposal['id'], proposal['digest'], 'user')
        second = overview.pending_reviews(self.registry, before_id=first['next_before_id'])
        self.assertEqual(len(second['reviews']), 2)
        self.assertNotIn(row['id'], [value['id'] for value in second['reviews']])
        other = self.base / 'other'; other.mkdir(); other_id = self.registry.resolve(other)['id']
        with self.assertRaisesRegex(RegistryError, 'scope'):
            overview.pending_reviews(self.registry, other_id, first['next_before_id'])
        self.assertEqual(overview.pending_reviews(self.registry, other_id)['reviews'], [])

    def test_foreign_runner_binding_is_excluded_from_global_counts_and_rows(self):
        self.propose()
        self.registry.db.execute("UPDATE bindings SET runner_id='runner_elsewhere' WHERE workspace_id=?", (self.ws,))
        self.assertEqual(overview.pending_reviews(self.registry)['reviews'], [])
        self.assertEqual(overview.workspace_overviews(self.registry)['workspaces'], [])
        with self.assertRaisesRegex(RegistryError, 'not found'): overview.pending_reviews(self.registry, self.ws)

    def test_bounded_corrupt_ledger_and_global_archive_limit_fail_closed(self):
        self.propose(request_key='one'); self.propose(request_key='two')
        with patch.object(outcomes, 'MAX_PROPOSALS', 1), self.assertRaisesRegex(RegistryError, 'bounded proposal archive'):
            overview.pending_reviews(self.registry)
        self.registry.db.execute('DROP TRIGGER immutable_session_outcome')
        self.registry.db.execute('UPDATE workspace_session_outcomes SET payload=?', ('x' * 100000,))
        with self.assertRaises(RegistryError): overview.pending_reviews(self.registry)
        # Counts do not need to load the corrupt proposal body to remain bounded.
        self.assertEqual(overview.workspace_overviews(self.registry)['workspaces'][0]['counts']['reviews_session_outcome'], 2)

    def test_count_queries_are_grouped_and_read_pages_never_mutate(self):
        self.propose(); before = self.registry.db.total_changes
        with patch('subprocess.Popen', side_effect=AssertionError('Read does not execute')):
            overview.pending_reviews(self.registry); overview.workspace_overviews(self.registry)
        self.assertEqual(self.registry.db.total_changes, before)
        queries=[]; self.registry.db.set_trace_callback(queries.append)
        overview.workspace_overviews(self.registry); count = len(queries)
        self.propose(request_key='two'); queries.clear()
        overview.workspace_overviews(self.registry)
        self.assertEqual(len(queries), count)
        self.registry.db.set_trace_callback(None)


if __name__ == '__main__': unittest.main()

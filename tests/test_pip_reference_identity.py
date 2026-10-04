"""Malformed reference identities fail before metadata decoding or state changes."""
import sqlite3
import unittest
from unittest.mock import patch

from dgc import pip_references as references
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class PipReferenceIdentityTests(unittest.TestCase):
    setUp=fixtures.LocalPipsTests.setUp

    def discover(self, session='chat-one'):
        with patch.object(references,'state_directory',return_value=self.registry.directory):
            return references.discover(self.cfg,session)

    def test_surrogate_control_and_utf8_overflow_session_ids_refuse_before_database(self):
        for value in ('\ud800','chat\nnew','chat\x7f','🌱'*65,'a'*257,'bad/name','bad\\name',b'chat'):
            with self.subTest(value=repr(value)),patch.object(references,'state_directory',side_effect=AssertionError('No registry open')):
                with self.assertRaisesRegex(RegistryError,'owning chat'):self.discover(value)

    def test_valid_bounded_session_identity_keeps_unsaved_chat_read_only(self):
        before='\n'.join(self.registry.db.iterdump())
        result=self.discover('chat-new')
        self.assertEqual(result['workspace_id'],self.workspace['id'])
        self.assertEqual(result['pips'],[])
        self.assertEqual('\n'.join(self.registry.db.iterdump()),before)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM session_workspaces').fetchone()[0],0)

    def test_malformed_binding_identity_refuses_before_pip_projection(self):
        self.registry.db.execute('PRAGMA foreign_keys=OFF')
        for field,value in (('workspace_id','not-a-workspace'),('workspace_id',sqlite3.Binary(b'ws_blob')),
                            ('id','not-a-binding'),('id',sqlite3.Binary(b'binding_blob'))):
            original=dict(self.registry.db.execute('SELECT * FROM bindings').fetchone())
            try:
                self.registry.db.execute('UPDATE bindings SET '+field+'=?',(value,))
                with self.subTest(field=field,value=value),patch.object(references,'_project',side_effect=AssertionError('No Pip decode')):
                    with self.assertRaisesRegex(RegistryError,'binding identity'):self.discover()
            finally:self.registry.db.execute('UPDATE bindings SET '+field+'=?',(original[field],))

    def test_malformed_association_identity_refuses_before_projection(self):
        binding=self.registry.binding(self.workspace['id'])['id']
        self.registry.db.execute('PRAGMA foreign_keys=OFF')
        self.registry.db.execute('INSERT INTO session_workspaces VALUES(?,?,?,?)',
            ('chat-one','bad-workspace',binding,self.registry.clock()))
        with patch.object(references,'_project',side_effect=AssertionError('No Pip decode')):
            with self.assertRaisesRegex(RegistryError,'association identity'):self.discover()

    def test_existing_chat_cannot_change_workspace(self):
        self.registry.associate_session('chat-one',self.root)
        other=self.base/'other';other.mkdir();self.registry.resolve(other);self.cfg.project_root=other
        with patch.object(references,'_project',side_effect=AssertionError('No foreign decode')):
            with self.assertRaisesRegex(RegistryError,'different Pip workspace'):self.discover()

"""Saved Markdown export remains private, bounded and exclusive."""
import hashlib
import unittest
from dgc import pip_export, pip_cli
from dgc.workspace_registry import RegistryError
from tests.test_pips_local import LocalPipsTests


class MarkdownExportTests(unittest.TestCase):
    setUp = LocalPipsTests.setUp

    def result(self):
        job=self.store.create(self.registry.personal()['id'],'Weekend planner','Prepare a plan','user')
        run=self.store.enqueue(job['id'],'one','user',self.cfg)
        self.store.claim_next()
        self.store.finish(run['id'],result={'text':'## Saturday\n\n- Visit the park.','external_actions':False,'tools_called':0,'usage':{}})
        return run['id']

    def export(self,run_id,path):
        return pip_export.export_run(self.cfg,run_id,path,directory=self.registry.directory,format='markdown')

    def test_document_is_readable_private_and_hashes_the_complete_file(self):
        run_id=self.result();path=self.base/'weekend.md'
        before='\n'.join(self.registry.db.iterdump())
        value=self.export(run_id,path)['export'];raw=path.read_bytes()
        self.assertIn(b'## Saturday',raw);self.assertIn(run_id.encode(),raw)
        self.assertNotIn(b'"type":"header"',raw)
        self.assertEqual(value['format'],'text/markdown')
        self.assertEqual(value['sha256'],hashlib.sha256(raw).hexdigest())
        self.assertEqual(value['bytes'],len(raw))
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        self.assertEqual(before,'\n'.join(self.registry.db.iterdump()))

    def test_existing_destination_and_symlink_are_not_replaced(self):
        run_id=self.result();path=self.base/'existing.md';path.write_text('Keep me')
        with self.assertRaises(RegistryError):self.export(run_id,path)
        link=self.base/'link.md';link.symlink_to(path)
        with self.assertRaises(RegistryError):self.export(run_id,link)
        self.assertEqual(path.read_text(),'Keep me')
        self.assertEqual(list(self.base.glob('*.partial')),[])

    def test_nonterminal_or_failed_run_has_no_document(self):
        job=self.store.create(self.registry.personal()['id'],'Helper','Plan','user')
        run=self.store.enqueue(job['id'],'one','user',self.cfg);path=self.base/'result.md'
        with self.assertRaises(RegistryError):self.export(run['id'],path)
        self.store.claim_next();self.store.finish(run['id'],error={'code':'failed','message':'No result'})
        with self.assertRaises(RegistryError):self.export(run['id'],path)
        self.assertFalse(path.exists());self.assertEqual(list(self.base.glob('.dgc-pip-export-*')),[])

    def test_cli_exposes_format_without_changing_default_evidence(self):
        args=['export-run','run_'+'a'*32,'--output','/tmp/result.md']
        self.assertEqual(pip_cli.parser().parse_args(args).format,'jsonl')
        self.assertEqual(pip_cli.parser().parse_args(args+['--format','markdown']).format,'markdown')

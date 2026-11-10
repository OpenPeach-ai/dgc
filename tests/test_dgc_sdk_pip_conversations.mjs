/** Pips API 79 in the TypeScript SDK: several conversations per Pip. The four new commands and the optional
 *  conversation_id on send, list, mark read and the context meter: known, refused before API 79, then sent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const PIP = 'pip_' + 'a'.repeat(32), CONV = 'conv_' + 'b'.repeat(32);
const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
function fixture(version) {
  const calls = [];
  const wire = { request: async (payload, response, opts) => {
    calls.push(payload);
    return { type: 'pips_result', request_id: opts.requestId, command: payload.request.type, ok: true, result: { request: payload.request } };
  } };
  return { calls, session: new Session(wire, { capabilities: { pips_supported: true, pips_enabled: true, pips_api_version: version } }, init) };
}

test("a Pip's conversations: refused before API 79, then sent", async () => {
  assert.deepEqual([...COMMAND_FIELDS.list_pip_conversations], ['pip_id', 'archived']);
  assert.deepEqual([...COMMAND_FIELDS.archive_pip_conversation], ['pip_id', 'conversation_id', 'archived']);
  const old = fixture(78);
  await assert.rejects(old.session.pips.read('list_pip_conversations', { pip_id: PIP }),
    (e) => e instanceof DGCUnsupportedError && /API 79/.test(e.message));
  await assert.rejects(old.session.pips.mutate('create_pip_conversation', { pip_id: PIP, title: 'Trip' }, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 79/.test(e.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(79);
  const sent = (await current.session.pips.mutate('rename_pip_conversation', { pip_id: PIP, conversation_id: CONV, title: 'Goa' },
    { approved: true })).request;
  assert.deepEqual([sent.type, sent.conversation_id, sent.title], ['rename_pip_conversation', CONV, 'Goa']);
});

test('a conversation on the chat commands needs API 79 and its id', async () => {
  const old = fixture(78);
  await assert.rejects(old.session.pips.read('list_pip_messages', { pip_id: PIP, conversation_id: CONV }),
    (e) => e instanceof DGCUnsupportedError && /API 79/.test(e.message));
  const plain = (await old.session.pips.read('list_pip_messages', { pip_id: PIP })).request;
  assert.equal('conversation_id' in plain, false, 'without one, an older runtime is asked as before');
  const current = fixture(79);
  const sent = (await current.session.pips.read('list_pip_messages', { pip_id: PIP, conversation_id: CONV })).request;
  assert.equal(sent.conversation_id, CONV);
  await assert.rejects(current.session.pips.read('list_pip_messages', { pip_id: PIP, conversation_id: '../etc' }));
});

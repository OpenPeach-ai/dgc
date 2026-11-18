/** Pips API 106 in the TypeScript SDK: a question card in a Pip's chat (send_pip_message's `questions`;
 *  answer_pip_questions): known with the runtime's fields, refused before API 106, then sent. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCUnsupportedError, DGCConfigError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const REPLY = 'message_' + 'a'.repeat(32), PIP = 'pip_' + 'b'.repeat(32);
const ANSWER = { pip_id: PIP, message_id: REPLY, idempotency_key: 'answer-1', answers: { q1: { selected: [0], other: '' } } };
const DISMISS = { pip_id: PIP, message_id: REPLY, dismissed: true };
const SEND = { pip_id: PIP, text: 'Propose me options', idempotency_key: 'k-1', questions: true };
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

test('A question card: the runtime fields, refused before API 106, then sent', async () => {
  assert.deepEqual([...COMMAND_FIELDS.answer_pip_questions].sort(), ['answers', 'chat_options', 'dismissed', 'idempotency_key', 'message_id', 'pip_id']);
  assert.ok(COMMAND_FIELDS.send_pip_message.includes('questions'));
  const old = fixture(105);
  for (const fields of [ANSWER, DISMISS]) {
    await assert.rejects(old.session.pips.mutate('answer_pip_questions', fields, { approved: true }),
      (e) => e instanceof DGCUnsupportedError && /API 106/.test(e.message));
  }
  await assert.rejects(old.session.pips.mutate('send_pip_message', SEND, { approved: true }),
    (e) => e instanceof DGCUnsupportedError && /API 106/.test(e.message));
  assert.equal(old.calls.length, 0);
  const current = fixture(106);
  for (const [command, fields] of [['answer_pip_questions', ANSWER], ['answer_pip_questions', DISMISS], ['send_pip_message', SEND]]) {
    assert.equal((await current.session.pips.mutate(command, fields, { approved: true })).request.type, command);
  }
  for (const fields of [{ ...ANSWER, message_id: 'm1' }, { ...ANSWER, dismissed: true }, { ...DISMISS, dismissed: false },
    { pip_id: PIP, message_id: REPLY, answers: ANSWER.answers }, { ...ANSWER, answers: {} }, { pip_id: PIP, message_id: REPLY }]) {
    await assert.rejects(current.session.pips.mutate('answer_pip_questions', fields, { approved: true }), (e) => e instanceof DGCConfigError);
  }
  await assert.rejects(current.session.pips.mutate('send_pip_message', { ...SEND, questions: 'yes' }, { approved: true }), (e) => e instanceof DGCConfigError);
  assert.equal(current.calls.length, 3);
});

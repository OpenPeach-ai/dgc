import assert from 'node:assert/strict';
import test from 'node:test';
import { dgcCommandError, dgcEventError } from '../editors/vscode/src/protocol.generated.ts';
import { KNOWN_EVENTS } from '../sdk/typescript/src/transport.ts';
import { Session } from '../sdk/typescript/src/session.ts';

test('generated editor validator preserves scoped Pips and upstream chat controls', () => {
  for (const command of [
    { type: 'pips_control', request: { type: 'get_pip', request_id: 'one', pip_id: 'pip_rook' } },
    { type: 'pips_enable', enabled: true, request_id: 'one' },
    { type: 'pips_runtime', action: 'start', request_id: 'one' },
    { type: 'open_chat', cwd: '/workspace', request_id: 'one' },
    { type: 'close_chat', request_id: 'one' },
  ]) {
    assert.equal(dgcCommandError({ ...command, chat_id: 'c1' }), undefined);
    assert.equal(dgcCommandError({ ...command, chat_id: 'c2' }), undefined);
    for (const chat_id of ['', 'c'.repeat(65), null, [], true]) {
      assert.notEqual(dgcCommandError({ ...command, chat_id }), undefined);
    }
  }
});

test('SDK keeps both Pips and upstream events; closed envelopes retain each reply owner', () => {
  for (const name of ['pips_result', 'pips_status', 'prompt_pips', 'chat_opened', 'chat_closed',
    'agent_step', 'agent_message']) assert.equal(KNOWN_EVENTS.has(name), true);
  for (const chat_id of ['c1', 'c2']) {
    const event = { type: 'pips_result', seq: 1, chat_id, request_id: 'same-correlation',
      command: 'get_pip', ok: true, result: { workspace_id: `ws_${chat_id}` } };
    assert.equal(dgcEventError(event), undefined);
    assert.notEqual(dgcEventError({ ...event, unexpected_privilege: true }), undefined);
  }
});

test('resume drops idle control events before replay without losing a pending Pip reply', async (t) => {
  t.mock.method(Date, 'now', () => 100);
  const session = Object.create(Session.prototype);
  session.pending = [];
  const reply = { event: { type: 'pips_result', request_id: 'one', command: 'get_pip', ok: true, result: {} } };
  const frames = ['session_named', 'history', 'agents', 'mode_changed'].map(type => ({ event: { type } }));
  frames.push(reply);
  session.read = async () => {
    assert.notEqual(frames.length, 0, 'the pending reply must end the idle drain');
    return frames.shift();
  };
  await session.discardIdle();
  assert.deepEqual(frames, []);
  assert.deepEqual(session.pending, [reply]);
});

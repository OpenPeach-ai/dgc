/** Plugin cards (MCP Apps) in the TypeScript SDK: session.cards (watch, get, call, answer, context, messageText) and the
 *  card events among the known ones. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, Cards, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { KNOWN_EVENTS } from '../sdk/typescript/src/transport.ts';

const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
const CARD = 'app_' + 'a'.repeat(24);

function fixture(capabilities) {
  const calls = [], sent = [], pending = new Map();
  const wire = {
    send: (payload) => { sent.push(payload); },
    request: async (payload, response) => {
      calls.push(payload);
      if (payload.type === 'mcp_app_answer') assert.equal(payload.request_id, pending.get(payload.ask_id), 'Host replies under the original call ID');
      if (payload.type === 'mcp_app_get') {
        assert.equal(response, 'mcp_app_resource');
        return { type: 'mcp_app_resource', request_id: payload.request_id, card_id: CARD, html: '<p>board</p>', csp_header: "default-src 'none'" };
      }
      assert.equal(response, 'mcp_app_reply');
      if (payload.type === 'mcp_app_call' && payload.params.name === 'move') {
        pending.set('ask_' + 'b'.repeat(24), payload.request_id);
        return { type: 'mcp_app_reply', request_id: payload.request_id, card_id: CARD,
          ask: { ask_id: 'ask_' + 'b'.repeat(24), tool: 'move', arguments: { to: 'a1' }, always: true, money: false } };
      }
      return { type: 'mcp_app_reply', request_id: payload.request_id, card_id: CARD, result: { content: [] } };
    },
  };
  return { calls, sent, session: new Session(wire, { capabilities }, init) };
}

test('the card events are known, so none is dropped', () => {
  for (const name of ['mcp_app_card', 'mcp_app_reply', 'mcp_app_resource']) assert.ok(KNOWN_EVENTS.has(name), name);
});

test('session.cards needs the capability', () => {
  assert.throws(() => fixture({}).session.cards, DGCUnsupportedError);
});

test('each call is one card command', async () => {
  const { calls, sent, session } = fixture({ mcp_apps: { version: 1 } });
  const cards = session.cards;
  assert.ok(cards instanceof Cards);
  cards.watch();
  assert.deepEqual(sent, [{ type: 'watch_mcp_apps' }]);
  assert.equal((await cards.get(CARD)).html, '<p>board</p>');
  assert.deepEqual(await cards.call(CARD, 'tools/call', { name: 'show_board' }), { result: { content: [] } });
  const asked = await cards.call(CARD, 'tools/call', { name: 'move', arguments: { to: 'a1' } });
  assert.equal(asked.ask.tool, 'move');
  assert.deepEqual(await cards.answer(asked, 'once'), { result: { content: [] } });
  const answer = calls.at(-1);
  assert.deepEqual([answer.type, answer.ask_id, answer.request_id], ['mcp_app_answer', 'ask_' + 'b'.repeat(24), asked.request_id]);
  await assert.rejects(cards.answer(asked, 'maybe'), TypeError);
  cards.context(CARD, [{ type: 'text', text: 'picked a2' }], { cell: 'a2' });
  assert.deepEqual(sent.at(-1), { type: 'mcp_app_context', card_id: CARD, content: [{ type: 'text', text: 'picked a2' }], structured_content: { cell: 'a2' } });
  assert.equal(Cards.messageText({ plugin: 'Board' }, ' bigger '), "From Board's card: bigger");
});


test('the inner ask retains correlation and missing correlation is rejected locally', async () => {
  const { calls, session } = fixture({ mcp_apps: { version: 1 } });
  const asked = await session.cards.call(CARD, 'tools/call', { name: 'move' });
  assert.deepEqual(await session.cards.answer(asked.ask, 'deny'), { result: { content: [] } });
  const count = calls.length;
  await assert.rejects(session.cards.answer({ ask_id: 'ask_' + 'b'.repeat(24) }, 'deny'), TypeError);
  assert.equal(calls.length, count);
});

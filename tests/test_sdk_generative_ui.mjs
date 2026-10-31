import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractGenerativeUi } from '../sdk/typescript/dist/index.js';

test('SDK reads a bounded card as data', () => {
  const card = { version: '1', title: 'ERP status', blocks: [
    { type: 'steps', items: [{ label: 'Audit', state: 'done' }] },
    { type: 'choices', items: [{ label: 'Review', reply: 'Review the alert' }] },
  ] };
  assert.deepEqual(extractGenerativeUi('Reply\n```dgc-ui\n' + JSON.stringify(card) + '\n```'), [card]);
  assert.deepEqual(extractGenerativeUi('```dgc-ui\n' + JSON.stringify({ ...card, blocks: [
    { type: 'choices', items: [{ label: 'Run', reply: '/init' }] },
  ] }) + '\n```'), []);
  for (const type of ['toString', 'constructor', '__proto__']) {
    assert.deepEqual(extractGenerativeUi('```dgc-ui\n' + JSON.stringify({ ...card, blocks: [
      { type, items: [{ label: 'Review', reply: 'Review the alert' }] },
    ] }) + '\n```'), [], `${type} must not be accepted as a card block`);
  }
});

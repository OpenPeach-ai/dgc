import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractGenerativeUi } from '../sdk/typescript/src/generativeUi.ts';

const CASES = JSON.parse(readFileSync(new URL('./fixtures/sdk_generative_ui.json', import.meta.url), 'utf8'));

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

test('SDK reads numbers and true/false as their text, as the editor draws them', () => {
  const card = { version: '1', title: 'Tests', blocks: [
    { type: 'metrics', items: [{ label: 'Passed', value: 42, detail: 3 }] },
    { type: 'table', columns: ['File', 'Lines', 'Typed'], rows: [['a.py', 120, true]] },
    { type: 'bars', items: [{ label: 2026, value: 8 }] },
  ] };
  assert.deepEqual(extractGenerativeUi('```dgc-ui\n' + JSON.stringify(card) + '\n```'), [{ version: '1', title: 'Tests', blocks: [
    { type: 'metrics', items: [{ label: 'Passed', value: '42', detail: '3' }] },
    { type: 'table', columns: ['File', 'Lines', 'Typed'], rows: [['a.py', '120', 'true']] },
    { type: 'bars', items: [{ label: '2026', value: 8 }] },
  ] }]);
  assert.deepEqual(extractGenerativeUi('```dgc-ui\n' + JSON.stringify({ version: '1', title: 'T', blocks: [
    { type: 'table', columns: ['A'], rows: [[{ n: 1 }]] }] }) + '\n```'), []);
});

test('SDK reads a reply as the Python SDK does (one fixture)', () => {
  for (const item of CASES) assert.equal(extractGenerativeUi(item.reply).length, item.cards, item.why);
});

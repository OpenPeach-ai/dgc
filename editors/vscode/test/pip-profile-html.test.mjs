import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computersMarkup } from '../src/pipProfile.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

test('computer setup progress is inert even when a malformed backend sends text counters', () => {
  const html = computersMarkup({
    setup: { state: 'running', step: 'Preparing', done: '<img src=x onerror=alert(1)>', total: 2 },
    computers: [], available: true,
  }, { esc, formatDate: () => '' });
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img'));
});

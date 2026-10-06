/** API24 per-message inference controls. Offline wire; no timers or network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, DGCConfigError, DGCUnsupportedError, DGCCommandRejectedError } from '../sdk/typescript/src/index.ts';
import { COMMAND_FIELDS } from '../sdk/typescript/src/pips.ts';

const caps = { pips_supported: true, pips_api_version: 25, pips_enabled: true };
const message = { pip_id: 'pip_rook', text: 'Explain this source excerpt.', idempotency_key: 'same-message' };
const options = { context_size: 8192, thinking: 'medium' };
const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
function fixture(capabilities = caps, changes = {}) {
  const calls = [];
  const wire = { transform: event => event, request: async (payload, response, opts) => {
    calls.push({ payload, response, opts });
    return wire.transform({ type: 'pips_result', request_id: opts.requestId,
      command: payload.request.type, ok: true, result: { request: payload.request } });
  } };
  return { calls, wire, session: new Session(wire, { capabilities }, { ...init, ...changes }) };
}

test('send allowlist adds only chat_options, images and files and never changes list request fields', () => {
  assert.deepEqual([...COMMAND_FIELDS.send_pip_message].sort(), ['chat_options','files','idempotency_key','images','pip_id','text']);
  assert.equal(COMMAND_FIELDS.list_pip_messages.includes('chat_options'), false);
});

test('images require API43 and must be image data URIs', async () => {
  const dot = 'data:image/png;base64,iVBORw0KGgo=';
  const old = fixture({ ...caps, pips_api_version: 42 });
  await assert.rejects(old.session.pips.mutate('send_pip_message', { ...message, images: [dot] }, { approved: true }), /API 43/);
  assert.equal(old.calls.length, 0);
  const current = fixture({ ...caps, pips_api_version: 43 });
  for (const images of [null, [], dot, [dot, dot, dot, dot, dot], ['https://example.com/a.png'], [1]]) {
    await assert.rejects(current.session.pips.mutate('send_pip_message', { ...message, images }, { approved: true }), DGCConfigError);
  }
  assert.equal(current.calls.length, 0);
  const answer = await current.session.pips.mutate('send_pip_message', { ...message, text: '', images: [dot] }, { approved: true });
  assert.deepEqual(answer.request.images, [dot]);
  assert.equal(current.calls.length, 1);
  const photo = 'data:image/png;base64,' + 'A'.repeat(1_900_000);
  const big = await current.session.pips.mutate('send_pip_message', { ...message, images: [photo] }, { approved: true });
  assert.deepEqual(big.request.images, [photo], 'a photo-sized image is not held to the 32 KiB budget');
  for (const params of [{ ...message, images: [photo, photo] }, { ...message, text: 'x'.repeat(40000), images: [photo] }]) {
    await assert.rejects(current.session.pips.mutate('send_pip_message', params, { approved: true }), DGCConfigError);
  }
  assert.equal(current.calls.length, 2);
});

test('files require API43, share the 2 MB budget and keep plain names', async () => {
  const note = { name: 'notes.txt', data: 'data:text/plain;base64,aGk=' };
  const old = fixture({ ...caps, pips_api_version: 42 });
  await assert.rejects(old.session.pips.mutate('send_pip_message', { ...message, files: [note] }, { approved: true }), /API 43/);
  const current = fixture({ ...caps, pips_api_version: 43 });
  for (const files of [null, [], [note, note, note, note, note], [{ name: '../x.txt', data: note.data }], [{ name: 'a.txt' }],
    [{ name: 'a.txt', data: 'https://example.com' }], [{ ...note, extra: 1 }]]) {
    await assert.rejects(current.session.pips.mutate('send_pip_message', { ...message, files }, { approved: true }), DGCConfigError);
  }
  const half = 'data:text/plain;base64,' + 'A'.repeat(1_500_000);
  await assert.rejects(current.session.pips.mutate('send_pip_message', { ...message, files: [{ name: 'a.txt', data: half }],
    images: ['data:image/png;base64,' + 'A'.repeat(1_500_000)] }, { approved: true }), DGCConfigError);
  assert.equal(current.calls.length, 0);
  const answer = await current.session.pips.mutate('send_pip_message', { ...message, text: '', files: [{ name: 'a.txt', data: half }] }, { approved: true });
  assert.deepEqual(answer.request.files, [{ name: 'a.txt', data: half }]);
  assert.equal(current.calls.length, 1);
});

test('large reply contexts require API25 and smaller requests remain API24 compatible', async () => {
  const current = fixture({ ...caps, pips_api_version: 24 });
  for (const context_size of [32769, 65536, 1048576]) {
    await assert.rejects(current.session.pips.mutate('send_pip_message',
      { ...message, chat_options: { ...options, context_size } }, { approved: true }), /API 25/);
  }
  assert.equal(current.calls.length, 0);
  await current.session.pips.mutate('send_pip_message', { ...message, chat_options: options }, { approved: true });
  assert.equal(current.calls.length, 1);
});

test('option presence requires API24 while absent options keep legacy API8 send', async () => {
  for (const version of [8, 12, 22, 23]) {
    const current = fixture({ ...caps, pips_api_version: version });
    for (const value of [options, {}, null]) {
      await assert.rejects(current.session.pips.mutate('send_pip_message', { ...message, chat_options: value }, { approved: true }), /API 24/);
    }
    assert.equal(current.calls.length, 0);
    const result = await current.session.pips.mutate('send_pip_message', message, { approved: true });
    assert.equal(Object.hasOwn(result.request, 'chat_options'), false);
    assert.equal(result.request.idempotency_key, 'same-message');
    assert.equal(current.calls.length, 1);
  }
});

test('all exact choices and boundary values forward detached without mutating input', async () => {
  const current = fixture();
  for (const size of [2048, 8192, 32768, 65536, 131072, 1048576]) for (const thinking of ['off','low','medium','high','xhigh']) {
    const params = { ...message, chat_options: { context_size: size, thinking } };
    const before = structuredClone(params);
    const result = await current.session.pips.mutate('send_pip_message', params, { approved: true });
    assert.deepEqual(params, before);
    params.chat_options.context_size = 2049;
    assert.deepEqual(result.request.chat_options, before.chat_options);
    assert.deepEqual(current.calls.at(-1).payload.request.chat_options, before.chat_options);
  }
  assert.equal(current.calls.length, 30);
});

test('malformed or authority-bearing options refuse before transport', async () => {
  const current = fixture();
  const invalid = [null, {}, [], 'high', { thinking: 'off' }, { context_size: 8192 },
    ...[true,false,2048.5,'8192',2047,1048577,-1,NaN,Infinity].map(context_size => ({ context_size, thinking: 'off' })),
    ...[null,true,1,[],'HIGH','max'].map(thinking => ({ context_size: 8192, thinking })),
    ...['permissions','mode','model','base_url','api_key','actor','max_tokens'].map(key => ({ ...options, [key]: 'forged' }))];
  for (const value of invalid) await assert.rejects(
    current.session.pips.mutate('send_pip_message', { ...message, chat_options: value }, { approved: true }), DGCConfigError);
  assert.equal(current.calls.length, 0);
});

test('new inference choices never override approval, policy, isolation or plan mode', async () => {
  const params = { ...message, chat_options: options };
  const current = fixture();
  for (const approved of [false,1,'true',null]) await assert.rejects(
    current.session.pips.mutate('send_pip_message', params, { approved }), DGCConfigError);
  assert.equal(current.calls.length, 0);
  for (const changes of [{ isolated: true }, { policy: {} }, { permissionMode: 'plan' },
    { sandbox: { requirement: 'required', active: false } }, { sandbox: { requirement: 'off', active: true } }]) {
    const restricted = fixture(caps, changes);
    await assert.rejects(restricted.session.pips.mutate('send_pip_message', params, { approved: true }), DGCUnsupportedError);
    assert.equal(restricted.calls.length, 0);
  }
  for (const capabilities of [{ ...caps, pips_enabled: false }, { ...caps, pips_supported: false },
    { ...caps, pips_api_version: true }, { ...caps, pips_api_version: '24' }]) {
    const restricted = fixture(capabilities);
    await assert.rejects(restricted.session.pips.mutate('send_pip_message', params, { approved: true }), DGCUnsupportedError);
    assert.equal(restricted.calls.length, 0);
  }
});

test('message reads retain old gate and pass optional chat_controls metadata unchanged', async () => {
  const current = fixture();
  const metadata = { version: 1, mode: 'read_only', options, options_source: 'last_message',
    inherited_context_size: 131072, effective_context_size: 8192, context_min: 2048, context_max: 32768,
    context_note: 'Bounded reply context, not a job change.', thinking_levels: ['off','low','medium','high','xhigh'],
    reasoning_control: 'provider_dependent', reasoning_note: 'Provider mappings vary.' };
  current.wire.transform = event => ({ ...event, result: { messages: [], chat_controls: metadata } });
  assert.deepEqual((await current.session.pips.read('list_pip_messages', { pip_id: 'pip_rook' })).chat_controls, metadata);
  const old = fixture({ ...caps, pips_api_version: 8 });
  old.wire.transform = event => ({ ...event, result: { messages: [] } });
  assert.deepEqual(await old.session.pips.read('list_pip_messages', { pip_id: 'pip_rook' }), { messages: [] });
});

test('backend rejection never retries, drops options or rewrites idempotency', async () => {
  const current = fixture();
  current.wire.transform = event => ({ ...event, ok: false,
    error: { code: 'idempotency_conflict', message: 'This key names a different reply request.' } });
  await assert.rejects(current.session.pips.mutate('send_pip_message', { ...message, chat_options: options }, { approved: true }),
    error => error instanceof DGCCommandRejectedError && error.reason === 'idempotency_conflict');
  assert.equal(current.calls.length, 1);
  assert.deepEqual(current.calls[0].payload.request.chat_options, options);
  assert.equal(current.calls[0].payload.request.idempotency_key, 'same-message');
});

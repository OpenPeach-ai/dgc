/** Image generation in the TypeScript SDK: session.images (generators, update, add, setKey, remove, setDefault,
 *  test, generate, library) and the images events among the known ones. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, Images, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { KNOWN_EVENTS } from '../sdk/typescript/src/transport.ts';

const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
const STATUS = { generators: [{ id: 'comfy', name: 'ComfyUI on gpu-box' }], default: 'comfy' };

function fixture(capabilities) {
  const calls = [];
  const wire = { request: async (payload, response) => {
    calls.push({ payload, response });
    if (payload.type === 'images_generate') {
      return { type: 'images_result', request_id: payload.request_id, ok: true, text: 'Made 1 image',
        images: [{ path: '/home/me/app/assets/generated/fox.png', seed: 3 }], generator: 'comfy', model: 'sdxl' };
    }
    if (payload.type === 'images_library') {
      return { type: 'images_library', request_id: payload.request_id, images: [], total: 0 };
    }
    return { type: 'images_status', request_id: payload.request_id, status: STATUS,
      ...(payload.type === 'images_update' ? { change: `did ${payload.action}` } : {}),
      ...(payload.action === 'test' ? { tested: { comfy: { ok: true } } } : {}) };
  } };
  return { calls, session: new Session(wire, { capabilities }, init) };
}

test('the images events are known, so none is dropped', () => {
  for (const name of ['images_status', 'images_result', 'images_library', 'images_made']) assert.ok(KNOWN_EVENTS.has(name), name);
});

test('session.images needs the capability', () => {
  assert.throws(() => fixture({}).session.images, DGCUnsupportedError);
});

test('each call is one images command', async () => {
  const { calls, session } = fixture({ images: { version: 1 } });
  const images = session.images;
  assert.ok(images instanceof Images);
  assert.deepEqual(await images.generators(), STATUS);
  assert.equal((await images.add('comfyui', { base_url: 'gpu-box.local:8188' })).change, 'did add_generator');
  await images.setKey('fal', 'fal-123');
  await images.setDefault('comfy');
  assert.deepEqual(await images.test('comfy'), { comfy: { ok: true } });
  const made = await images.generate('a red fox', { count: 2, saveTo: 'art', approve: true });
  assert.equal(made.images[0].seed, 3);
  assert.equal((await images.library({ query: 'fox' })).total, 0);
  assert.deepEqual(calls.map((c) => c.payload.type), ['images_list', 'images_update', 'images_update', 'images_update',
    'images_update', 'images_generate', 'images_library']);
  assert.equal(calls[1].payload.provider, 'comfyui');
  assert.equal(calls[2].payload.key, 'fal-123');
  assert.deepEqual([calls[5].payload.count, calls[5].payload.save_to, calls[5].payload.approve], [2, 'art', true]);
  assert.equal(calls[5].response, 'images_result');
});

test('a key goes only with set_key, and arguments are checked', async () => {
  const images = fixture({ images: { version: 1 } }).session.images;
  await assert.rejects(images.update('add_generator', { provider: 'fal', key: 'k' }), DGCConfigError);
  await assert.rejects(images.update('dance'), DGCConfigError);
  await assert.rejects(images.update('edit_generator', { generator: 'x', colour: 'red' }), DGCConfigError);
  await assert.rejects(images.generate(''), DGCConfigError);
  await assert.rejects(images.generate('x', { count: 9 }), DGCConfigError);
});

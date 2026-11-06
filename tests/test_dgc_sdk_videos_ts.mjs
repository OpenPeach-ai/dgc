/** Video generation in the TypeScript SDK: session.videos (generators, generate with approve and wait, jobs, stop,
 *  library) and the video events among the known ones. Offline wire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, Videos, DGCTimeoutError, DGCConfigError, DGCUnsupportedError } from '../sdk/typescript/src/index.ts';
import { KNOWN_EVENTS } from '../sdk/typescript/src/transport.ts';

const init = { options: {}, unhandled: 'deny', instructions: '', toolHub: null, cwd: null, policy: null,
  department: '', usageLog: null, auditLog: null, model: '', permissionMode: 'default', isolated: false,
  verifyCommand: '', stateLock: null, excludePaths: [], requestTimeoutMs: 1000,
  sandbox: { requirement: 'off', active: false, backend: '', reason: '' } };
const STATUS = { generators: [{ id: 'fal', makes: 'images' }, { id: 'fal-wan', makes: 'videos' }] };

function fixture(capabilities) {
  const calls = [];
  let polls = 0;
  const wire = { request: async (payload, response) => {
    calls.push({ payload, response });
    const rid = payload.request_id;
    if (payload.type === 'images_list') return { type: 'images_status', request_id: rid, status: STATUS };
    if (payload.type === 'videos_generate') {
      if (!payload.approve) {
        return { type: 'video_jobs', request_id: rid, jobs: [], card: { facts: '5 s · 720p · about $0.15' },
          error: { kind: 'needs_approval', message: 'x' } };
      }
      return { type: 'video_jobs', request_id: rid, change: 'Started', jobs: [{ id: 'vid_000000000001', state: 'queued' }] };
    }
    if (payload.type === 'videos_jobs') {
      polls += 1;
      return { type: 'video_jobs', request_id: rid, jobs: [{ id: 'vid_000000000001', state: polls >= 2 ? 'done' : 'running' }] };
    }
    if (payload.type === 'videos_stop') {
      return { type: 'video_jobs', request_id: rid, change: 'Stopped.', jobs: [{ id: payload.job, state: 'cancelled' }] };
    }
    return { type: 'videos_library', request_id: rid, videos: [], total: 0 };
  } };
  return { calls, session: new Session(wire, { capabilities }, init) };
}

test('the video events are known, so none is dropped', () => {
  for (const name of ['video_job', 'video_jobs', 'videos_library']) assert.ok(KNOWN_EVENTS.has(name), name);
});

test('session.videos needs the capability', () => {
  assert.throws(() => fixture({}).session.videos, DGCUnsupportedError);
});

test('each call is one videos command', async () => {
  const { calls, session } = fixture({ videos: { version: 1 } });
  const videos = session.videos;
  assert.ok(videos instanceof Videos);
  assert.deepEqual((await videos.generators()).map((g) => g.id), ['fal-wan']);
  const held = await videos.generate('a felt ball');
  assert.equal(held.ok, false);
  assert.equal(held.error.kind, 'needs_approval');
  const made = await videos.generate('a felt ball', { durationS: 5, aspect: '9:16', saveTo: 'assets', approve: true, pollMs: 1 });
  assert.equal(made.ok, true);
  assert.equal(made.job.state, 'done');
  assert.equal((await videos.stop('vid_000000000001')).state, 'cancelled');
  assert.equal((await videos.library({ query: 'ball' })).total, 0);
  assert.deepEqual(calls.map((c) => c.payload.type), ['images_list', 'videos_generate', 'videos_generate', 'videos_jobs',
    'videos_jobs', 'videos_stop', 'videos_library']);
  assert.deepEqual([calls[2].payload.duration_s, calls[2].payload.aspect, calls[2].payload.save_to, calls[2].payload.approve],
    [5, '9:16', 'assets', true]);
});

test('arguments are checked', async () => {
  const videos = fixture({ videos: { version: 1 } }).session.videos;
  await assert.rejects(videos.generate(''), DGCConfigError);
  await assert.rejects(videos.generate('x', { durationS: 0 }), DGCConfigError);
  await assert.rejects(videos.generate('x', { aspect: '4:3' }), DGCConfigError);
});


test('a video polling deadline raises the public timeout error', async () => {
  const videos = new Videos(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { jobs: [{ id: 'pending', state: 'running' }] };
  });
  await assert.rejects(videos.wait('pending', { timeoutMs: 0 }), DGCTimeoutError);
});

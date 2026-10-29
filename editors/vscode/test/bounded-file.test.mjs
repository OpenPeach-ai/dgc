import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const built = (await build({entryPoints: [new URL("../src/boundedFile.ts", import.meta.url).pathname],
  platform: "node", format: "cjs", bundle: true, write: false})).outputFiles[0].text;
function reader(overrides = {}, platform = process.platform) {
  const module = {exports: {}};
  new Function("require", "module", "exports", "process", built)(
    name => name === "fs" ? {...fs, ...overrides} : require(name), module, module.exports, {platform});
  return module.exports;
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "dgc-bounded-file-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const project = join(root, "project"), target = join(project, "shot.png");
  fs.mkdirSync(project); fs.writeFileSync(target, "png");
  return {root, project, target};
}
function tracked(overrides = {}) {
  const open = new Set();
  return {open, fs: {
    openSync(...args) { const fd = fs.openSync(...args); open.add(fd); return fd; },
    closeSync(fd) { fs.closeSync(fd); open.delete(fd); },
    ...overrides,
  }};
}

for (const method of ["readBoundedFile", "readBoundedFileSync"]) {
  test(`${method}: exact limit and empty files work; directories, links and oversized files do not`, async t => {
    const {root, project, target} = fixture(t), state = tracked(), read = reader(state.fs)[method];
    assert.equal((await read(target, 3)).toString(), "png");
    assert.equal(await read(target, 2), undefined);
    assert.equal(await read(project, 20), undefined);
    const link = join(root, "link.png"); fs.symlinkSync(target, link);
    assert.equal(await read(link, 20), undefined);
    fs.writeFileSync(target, "");
    assert.equal((await read(target, 0)).length, 0);
    assert.equal(state.open.size, 0);
  });

  test(`${method}: a growing file reads at most its checked size plus one byte`, async t => {
    const {target} = fixture(t);
    let grew = false, bytes = 0;
    const state = tracked({
      fstatSync(...args) {
        const info = fs.fstatSync(...args);
        if (info.isFile() && !grew) { grew = true; fs.appendFileSync(target, Buffer.alloc(256 * 1024)); }
        return info;
      },
      readSync(...args) { const count = fs.readSync(...args); bytes += count; return count; },
      read(fd, buffer, offset, length, position, callback) {
        fs.read(fd, buffer, offset, length, position, (error, count, data) => {
          bytes += count || 0; callback(error, count, data);
        });
      },
    });
    assert.equal(await reader(state.fs)[method](target, 128), undefined);
    assert.equal(grew, true);
    assert.ok(bytes <= 4, `read ${bytes} bytes from a file that grew after its three-byte size check`);
    assert.equal(state.open.size, 0);
  });

  test(`${method}: a final symlink replacement is refused and every descriptor closes`, async t => {
    const {root, target} = fixture(t), outside = join(root, "private.png");
    fs.writeFileSync(outside, "private");
    let swapped = false;
    const state = tracked({realpathSync(value, ...args) {
      const canonical = fs.realpathSync(value, ...args);
      if (value === target && !swapped) {
        swapped = true; fs.unlinkSync(target); fs.symlinkSync(outside, target);
      }
      return canonical;
    }});
    assert.equal(await reader(state.fs)[method](target, 128), undefined);
    assert.equal(swapped, true);
    assert.equal(state.open.size, 0);
  });

  test(`${method}: Linux parent traversal refuses a directory replaced by an external link`,
    {skip: process.platform !== "linux"}, async t => {
      const {root, project, target} = fixture(t), outside = join(root, "outside");
      fs.mkdirSync(outside); fs.writeFileSync(join(outside, "shot.png"), "private");
      let swapped = false;
      const state = tracked();
      const original = state.fs.openSync;
      state.fs.openSync = (value, ...args) => {
        if (typeof value === "string" && value.startsWith("/proc/self/fd/") && value.endsWith("/project")) {
          swapped = true; fs.renameSync(project, join(root, "held")); fs.symlinkSync(outside, project, "dir");
        }
        return original(value, ...args);
      };
      assert.equal(await reader(state.fs)[method](target, 128), undefined);
      assert.equal(swapped, true);
      assert.equal(state.open.size, 0);
    });

  test(`${method}: read errors close the opened file`, async t => {
    const {target} = fixture(t);
    const state = tracked({
      readSync() { throw new Error("read fixture"); },
      read(fd, buffer, offset, length, position, callback) { callback(new Error("read fixture"), 0, buffer); },
    });
    assert.equal(await reader(state.fs)[method](target, 128), undefined);
    assert.equal(state.open.size, 0);
  });

  test(`${method}: fallback identity checks reject a replacement even without O_NOFOLLOW`, async t => {
    const {root, target} = fixture(t), outside = join(root, "private.png");
    fs.writeFileSync(outside, "private");
    let swapped = false, reads = 0;
    const state = tracked({
      constants: {...fs.constants, O_NOFOLLOW: 0, O_NONBLOCK: 0},
      realpathSync(value, ...args) {
        const canonical = fs.realpathSync(value, ...args);
        if (value === target && !swapped) {
          swapped = true; fs.unlinkSync(target); fs.symlinkSync(outside, target);
        }
        return canonical;
      },
      readSync() { reads++; throw new Error("unexpected read"); },
      read(fd, buffer, offset, length, position, callback) { reads++; callback(new Error("unexpected read"), 0, buffer); },
    });
    // Exercise fallback logic on this runner; actual macOS/Windows validation is a separate gate.
    assert.equal(await reader(state.fs, "win32")[method](target, 128), undefined);
    assert.equal(swapped, true);
    assert.equal(reads, 0, "must reject the replaced file before reading");
    assert.equal(state.open.size, 0);
  });
}

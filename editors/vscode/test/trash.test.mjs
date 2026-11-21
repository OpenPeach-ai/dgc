// Removing a Library item where the editor has no trash (19 Nov, Remote-SSH: "Unable to delete file ... via trash because
// provider does not support it"): the file goes to that computer's own trash folder, restorable, never deleted outright.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const code = (await build({ entryPoints: [new URL("../src/trash.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm" })).outputFiles[0].text;
const { moveToComputersTrash, trashFile } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

test("where the editor can't trash a file, it goes to the computer's own trash, with its record", async () => {
  const home = mkdtempSync(join(tmpdir(), "dgc-trash-home-")), dir = mkdtempSync(join(tmpdir(), "dgc-trash-files-"));
  const file = join(dir, "test picture 1.png");
  writeFileSync(file, "png");
  await trashFile(async () => { throw new Error("Unable to delete file via trash because provider does not support it."); }, file, home);
  assert.equal(existsSync(file), false, "gone from the Library's folder");
  const kept = join(home, ".local/share/Trash/files/test picture 1.png");
  assert.equal(readFileSync(kept, "utf8"), "png", "in the trash, whole");
  const record = readFileSync(join(home, ".local/share/Trash/info/test picture 1.png.trashinfo"), "utf8");
  assert.match(record, /^\[Trash Info\]\nPath=.*\/test%20picture%201\.png\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);
  // A second file of the same name doesn't take the first one's place.
  writeFileSync(file, "png2");
  const second = await moveToComputersTrash(file, home);
  assert.match(second, /test picture 1 2\.png$/);
});

test("the editor's own trash comes first, and any other failure is said, nothing moved", async () => {
  const home = mkdtempSync(join(tmpdir(), "dgc-trash-home-")), dir = mkdtempSync(join(tmpdir(), "dgc-trash-files-"));
  const file = join(dir, "a.png"); writeFileSync(file, "x");
  let asked = 0;
  await trashFile(async () => { asked++; }, file, home);
  assert.equal(asked, 1); assert.equal(existsSync(join(home, ".local/share/Trash")), false, "the editor's trash took it");
  await assert.rejects(trashFile(async () => { throw new Error("EACCES: permission denied"); }, file, home), /permission denied/);
  assert.equal(existsSync(file), true, "left where it was");
});

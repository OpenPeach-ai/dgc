// The panel's half of a troupe's Stop: sent as stop_troupe only to a CLI that advertised troupes, only for a real run
// id, and answered by the `troupes` snapshot that updates its row above the prompt.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, makeProvider } from "./support/panel-bundle.mjs";

after(cleanup);

test("Stop on a troupe's row reaches a CLI that has troupes, and nothing else does", async () => {
  const { provider, backend } = makeProvider({ capabilities: { troupe: 1 } });
  await provider.stopTroupe("tr-0123456789");
  assert.equal(backend.requested.length, 1);
  assert.equal(backend.requested[0].type, "stop_troupe");
  assert.equal(backend.requested[0].run_id, "tr-0123456789");
  for (const bad of ["", "tr-xyz", "../etc", "tr-0123456789; rm"]) {
    await provider.stopTroupe(bad);
  }
  assert.equal(backend.requested.length, 1, "only a well-formed run id is ever sent");
  const older = makeProvider({ capabilities: {} });
  await older.provider.stopTroupe("tr-0123456789");
  assert.deepEqual(older.backend.requested, [], "an older CLI never had a troupe to stop");
});

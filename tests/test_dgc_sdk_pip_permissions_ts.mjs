import { test } from "node:test";
import assert from "node:assert/strict";
import { DISPLAY, engineDenyRules, policyDecision } from "../sdk/typescript/src/policy.ts";

for (const [name, label] of [["pips_setup", "PipsSetup"], ["run_pip_now", "PipsRun"], ["handoff_to_pip", "PipsHandoff"],
    ["pause_pip", "PipsPause"], ["resume_pip", "PipsResume"], ["attach_pip_to_session", "PipsAttach"]]) {
  test(`${label} is an explicit SDK permission and stays outside a read-only allowlist`, () => {
    assert.equal(DISPLAY[name], label);
    const request = { id: "permission-fixture", name, args: {} };
    for (const spelling of [name, label]) {
      const policy = { denyTools: [spelling], network: "allow" };
      assert.equal(policyDecision(policy, request), "deny");
      assert.ok(engineDenyRules(policy).includes(label));
    }
    const readOnly = { allowTools: ["read_file", "pips_context"], network: "allow" };
    assert.equal(policyDecision(readOnly, request), "deny");
    assert.ok(engineDenyRules(readOnly).includes(label));
  });
}

---
name: batch
description: Decompose a large repetitive change into independent units, fan them out across `task` sub-agents, then collect and verify.
---
Batch out this repetitive change: $ARGUMENTS

The goal is to split a big, mechanical, many-target change into independent units and run them concurrently with the `task` tool (each `task` spins up a fresh autonomous sub-agent, which may run on a different local model/host).

1. Enumerate the units. Use glob/grep to find every target (every file, module, call site, endpoint, etc.). List them explicitly. Know the exact scope before you fan out.

2. Check for independence — this is the critical safety step. Group the units:
   - INDEPENDENT: each unit touches its own file(s) and nothing else. These are safe to parallelize.
   - SHARED / COUPLED: multiple units edit the SAME file, or one unit's change is a prerequisite for another (shared imports, a common signature, a registry file, ordering dependencies). These are NOT safe to run in parallel — concurrent sub-agents would clobber each other's edits.

3. For the independent units, fan out. Launch one `task` sub-agent per unit (or per small batch of units). Give each sub-agent a self-contained prompt: the exact file(s) it owns, the precise change to make, the pattern to follow (point at one already-correct example), and an instruction to verify its own edit. Keep each sub-agent's scope disjoint from the others.

4. For the coupled/shared units, do them SERIALLY yourself in the main loop, in dependency order. Do not hand two sub-agents the same file.

5. Collect and verify. As sub-agents finish, gather their results. Then verify the whole batch as one: run the build/tests/linter with bash across all changed files, and spot-check a few by reading them. Fan-out speed does not excuse skipping the final check — invoke the `verify` skill if a runtime check is warranted.

6. Report: how many units, how you partitioned them (parallel vs serial and why), what each produced, and the result of the final verification. Call out any unit that failed or needs a human.

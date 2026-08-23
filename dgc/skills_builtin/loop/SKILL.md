---
name: loop
description: Drive a multi-step task to a checkable done-condition without thrashing — anchor a known-good checkpoint, take one small step at a time, and REVERT any step that regresses instead of stacking fixes on a broken tree.
---
Converge on the goal: $ARGUMENTS

This is a convergence rail, not a verification. Its whole job is to reach a done-condition through small steps while never letting the tree get worse than the last good point. DGC has no scheduler — you loop yourself, within the turn, one checked step at a time.

1. State the done-condition as a CHECK. Write down exactly what "finished" means as a single command or observation that passes or fails: "`npm test` exits 0", "`curl :3000/health` returns 200", "grep finds zero matches". If the goal is vague, sharpen it until it is one pass/fail check. Record the goal and sub-steps with the `todo` tool.

2. Anchor a known-good checkpoint BEFORE you change anything. Make sure the tree is committed (`git add -A && git commit` via bash) or note the current commit with `git rev-parse HEAD`. This is your revert target. Run the check once to record the starting state.

3. Take ONE small step. Make a single focused change with edit_file/write_file — the smallest edit that could move the check. Do not batch several changes into one step; if you can't tell which edit moved the needle, the step was too big.

4. Re-run the check — hand the actual verification to the `verify` skill (invoke it via the skill tool) or run the done-condition command with bash directly. Read the real output, don't assume.

5. Branch on the result:
   - BETTER but not done → commit this step as the new good checkpoint, then go to 3.
   - WORSE than the last checkpoint → REVERT immediately with git via bash: `git checkout -- <files>` for uncommitted work, or `git reset --hard <good-commit>` to a checkpoint commit. (The user can also undo interactively with `/rewind`.) Then try a DIFFERENT approach. Never patch a broken tree — a regressed step is discarded, not repaired.

6. Terminate explicitly:
   - DONE → the check passes. Run it one final time and report the passing output as evidence.
   - BLOCKED → you stopped making progress or hit something you can't resolve (missing credential, outage, ambiguous requirement, needs a human). Stop looping. Say precisely what is blocking and the smallest thing needed to unblock.

Rules:
- ALWAYS anchor a good checkpoint before the first change — you cannot revert to a point you never marked.
- On regression, REVERT to the last checkpoint. Do not stack fixes on a broken tree.
- Never refactor, patch, or add features while the check is red — get back to green first.
- One small step per cycle, re-check every cycle. No blind multi-edit bursts.
- Never declare DONE without running the final check and quoting its output.

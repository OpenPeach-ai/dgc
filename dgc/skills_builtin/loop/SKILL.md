---
name: loop
description: Iterate a task to completion — define the done-condition up front, work in small verifiable steps, run the check after each, and keep going until it holds or you're genuinely blocked.
---
Drive this task to completion: $ARGUMENTS

DGC has no background scheduler — this is disciplined manual iteration WITHIN the turn. You keep looping yourself until the goal is objectively met.

1. Define the done-condition FIRST, and make it checkable. State precisely what "finished" means as something you can test with bash or observe: "`npm test` exits 0", "the endpoint returns 200 with the expected body", "grep finds zero remaining occurrences", "all N items processed". A vague goal ("make it better") can't terminate a loop — sharpen it until it's a concrete pass/fail check. Use the `todo` tool to record the goal and the sub-steps.

2. Establish the baseline. Run the check once now to see the current state and how far you are from done.

3. Iterate in small steps. Each cycle:
   - make ONE focused change with edit_file/write_file,
   - run the done-condition check with bash,
   - read the result and compare to the goal.
   Keep steps small enough that when the check moves, you know exactly which change moved it. Update the `todo` list as items complete.

4. Use the feedback. If the check improved but isn't met, continue. If it regressed, revert that step (or use /rewind to a good checkpoint) and try a different approach — don't stack changes on a broken state.

5. Terminate correctly:
   - DONE: the condition holds. Run the full check one final time to confirm, and report the passing output.
   - BLOCKED: you've stopped making progress or hit something you can't resolve (missing credential, external outage, ambiguous requirement, needs a human decision). Stop looping — do not thrash. Report precisely what's blocking, what you tried, and the smallest thing needed to unblock.

Avoid two failure modes: declaring victory without running the final check, and looping forever making cosmetic changes that never move the condition. Every iteration must be justified by the check.

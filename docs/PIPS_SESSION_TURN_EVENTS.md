# Saved foreground turn events

`session_turn_events.py` records a native foreground turn that completed and whose
final session save succeeded. It does not say that the session is permanently
finished, that a standing goal completed, that any command ran, that tests passed,
or that source files are currently correct.

API18 integrates this module with the additive registry schema18 migration,
native frontend/Agent hooks and reviewed trigger choice. The module itself does
not start a supervisor or enqueue work. Deterministic integration tests run only
against disposable profiles; native configured-model/UI acceptance is pending.

## Private controller contract

The actual trusted frontend worker scopes a native call with
`foreground_turn('foreground_prompt')` or
`foreground_turn('foreground_continue')`. The module uses a `ContextVar`, restores
the previous value on exceptions and does not inherit the value into unrelated
threads. `current_origin()` returns that private origin or `None`. Known excluded
origins (`agent_wake`, `monitor`, `goal_resume`, `child`, `pip`, `vendor`) mask an
outer foreground scope; unknown origins are refused. This value is never accepted
from tool arguments, prompt text, protocol fields or a mutable Agent origin flag.

`begin_for_agent(agent)` returns an opaque, frozen process-local reservation. Its
scope comes from the existing private session association, local runner binding,
native session path, session root, session existence flag and initial revision.
It makes no association and reads no transcript, source file or source inventory.
For first-turn coverage, the frontend must establish the ordinary session
association before beginning the reservation. Otherwise the turn remains usable
but is not observed for this feature.

`complete_for_agent(agent, reservation, *, completed, saved,
revision_before_save)` accepts only literal `True` terminal/save facts and a real
native saved-session flag. The current native revision must equal
`revision_before_save + 1` and exceed the initial revision. Intermediate progress
saves can advance the revision; they never call this terminal hook. The hook
rechecks the session path, root, private association dates, binding identity and
binding dates, feature/policy eligibility, errors and cancellation. It records
nothing for failed, cancelled, stopped, unsaved, child, Pip, monitor, restricted or
vendor-delegated work. Depth zero alone does not identify a human foreground turn.

The helper trusts the final native save result while the controller still owns
the session turn lease. It does not reparse the transcript to prove persistence
again. An out-of-band deletion after that successful save does not invalidate the
historical fact that the save succeeded. Generation/deletion conflicts during
the turn must be refused by the existing native `_persist()` generation check.

The lower-level `reserve()` and `record()` functions support native controller
integration and disposable tests. They are not public controls or model tools;
deserialized reservations and caller-authored completion facts grant no authority.

## Ledger and event

`SCHEMA` defines immutable `session_turn_completions` rows, one scope index and
update/delete refusal triggers. The row binds session/workspace/turn identity,
final revision, a canonical request digest, a canonical receipt and its digest,
record time, and original event ID/sequence. Unique keys prevent duplicate turn
IDs or multiple completion identities for the same session save revision.

There are at most 10,000 rows per private registry, with a maximum 2,048 UTF-8 bytes
per receipt. Existing exact retries remain readable at capacity; new events are
refused with a notice. This is a retention limit, not automatic pruning or quota
reclamation. SQL byte guards run before reading stored JSON. Exact scalar types,
canonical bytes, stored columns and digests must agree before a retry is returned.
Configured-secret collisions in metadata are refused rather than changing pins.

The ledger insertion and `workspace_session_turn_completed` event commit in one
SQLite transaction. Event payload contains only:

```json
{
  "completion_id": "completion_<uuid>",
  "session_id": "<native session ID>",
  "turn_id": "turn_<uuid>",
  "final_revision": 2,
  "outcome": "foreground_turn_saved",
  "verification": "no_execution_or_test_claim"
}
```

The event retains the authoritative workspace ID in its normal event columns.
It contains no transcript, prompt, response, commands, output, model route,
filesystem path, source digest, or test claim. The original event sequence and
ID remain in the ledger after ordinary activity retention removes the event.
An exact completion retry returns its original receipt and never emits again.
The return is `{completion, digest, event_id, event_seq, replayed}`.

## Crash and trigger semantics

The session file and SQLite ledger are not a single transaction. A crash after
the successful final file save but before the ledger commit leaves an unobserved
turn. The module never backfills that gap from transcripts, timestamps, process
death, optional verifier receipts or model prose. Restart recovery covers only
already-recorded events and queued runs. A controller notification failure does
not turn an otherwise successful chat into a failed chat.

The reviewed `session_turn_completed` trigger uses the current event
planner: approved job version, metadata-only immutable event pin, latest-event
coalescing, cooldown, atomic cursor/run insertion, pause/archive/global-stop
backlog discard and explicit activity-retention uncertainty. Enablement starts
at the current cursor; it does not replay historical completions. Eligible jobs
remain committed-source read-only auditors. A resulting audit inspects the
currently approved committed source selected at enqueue, not a reconstructed
session-era source snapshot.

Working-tree file watchers, session failure events, external integration events,
notifications beyond local UI, and transcript exchange are outside this increment.

## Native integration point

`Agent.run_turn` keeps its public signature unchanged. Inside its owning turn
lease, after generation validation and normal association, it begins a reservation
only when `current_origin()` is present. It captures `_session_revision` immediately
before the final `_persist()` call. After terminal cleanup/Stop hook and
terminal-error handling, completion accepts only `completed is True` and
`saved is True`.
Exceptions, early returns and cancellation must not reach a successful marker.

Wrap actual native CLI one-shot/interactive user calls and native headless
`prompt`/explicit `continue` calls in the appropriate origin. Set it in the worker
thread, not merely the UI enqueueing thread. Do not wrap headless automatic
`resume`, child-notice wake, monitors, ACP/delegated engines or Pip workers.
Automatic cycles inside a user-started standing-goal turn do not emit separate
events. The caller keeps its session turn lease until final recording; the module
holds no SQLite transaction across model work or transcript persistence.

## Validation

`tests/test_session_turn_events.py` uses actual disposable session saves and
private workspace associations. It covers metadata-only output, read-only
reservation, closed origin/thread cleanup, exclusions, final-save generation,
first saves, cancellation, binding changes, scope before decode, immutable rows,
SQL cell guards, exact retries after event retention, conflicting identities,
two-connection races, rollback of both insertion and retention, capacity refusal,
secret collisions and the deliberately unrecovered save/SQLite gap. Tests use no
network, provider calls, sleeps, workers or private live profile.

`tests/test_session_turn_agent.py` exercises the real Agent loop with mocked model
responses: successful final persistence, first-turn association, explicit continue,
no/excluded origins, failed final save, actual file deletion before the final
generation check, cancellation including the Stop hook, partial progress saves,
model failure and optional ledger failure. `tests/test_session_turn_migration.py`
checks schema17→18 preservation of every old table and an existing native-command
context snapshot, plus full migration rollback/retry. These are deterministic
implementation tests, not evidence of a real configured-model or UI run.

## Separate native acceptance

The private Linux lab subsequently ran one normal foreground turn with the
configured local `qwen3.8:27b-q4km` model. It used one provider request and no tools.
The first save associated the session with its workspace; final revision 3
produced exactly one metadata completion and event. Root independently checked
the canonical receipt/request hashes and closed event fields. The source,
configuration and all 25 existing Pip runs stayed unchanged, and no event trigger
was enabled. Evidence is in `../output/pips-session-turn-native-evidence.json`
and `../output/pips-session-turn-root-check.json` from the lab root. The initial
QA observer refusal is retained separately; it stopped before model work.

The real isolated VS Code extension also displayed the API18 “Session turn saved”
schedule choice at 284px content width without overflow. The draft was reset and
reopened to confirm no schedule or proposal was saved. See the lab's
`output/pips-session-trigger-native-ui-evidence.json`. Neither check demonstrates
an event-triggered native audit, authenticated Remote delivery or physical iOS.

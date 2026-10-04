# Reviewed committed-path triggers

API22/schema22 add a reviewed filter for local committed-source observations.
Scout, Lens, Rook and Lock produce their existing read-only audits. Quill produces
its existing private documentation draft. This feature does not observe editor
writes or dirty/untracked files, run commands, change source policy, or grant tools.
Native acceptance is pending; deterministic disposable Git and mocked-provider
checks are separate evidence.

## Review and CLI

The existing proposal and acceptance flow carries this additive policy:

```json
{
  "events": ["committed_paths_changed"],
  "minimum_minutes": 5,
  "missed_policy": "coalesce_latest",
  "commit_paths": [
    {"kind": "exact", "path": "pyproject.toml"},
    {"kind": "directory", "path": "src"}
  ]
}
```

```text
dgc pips trigger PIP --expected-version VERSION \
  --events committed_paths_changed --path pyproject.toml --directory src
dgc pips accept PIP PROPOSAL --expected-version VERSION
```

The first command saves a proposal. Only accepting its exact saved version arms
the policy. `--path` and `--directory` may be repeated. `--off` proposes disabling
the event policy; it does not accept the change automatically. SDKs and clients
require API22 for the new event or field and never downgrade it to all commits.

Rules are literal, case-sensitive repository paths, not Git pathspecs or globs.
An exact rule matches one tree entry, including a symlink or gitlink entry without
following it. A directory rule matches descendants: `src/a.py` matches `src`, but
`src2/a.py` and an entry named exactly `src` do not. Deleted entries and mode/type
changes count; renames are separate deletion/addition records.

There are 1–32 rules, each path is at most 256 UTF-8 bytes, and the whole canonical
JSON rule list is at most 2,048 bytes including escaping. Duplicate paths are
refused even across rule kinds. Canonical order is UTF-8 path bytes, then kind.
Overlapping distinct rules remain visible. Absolute paths, empty/dot/parent
components, repeated separators, leading/trailing slash, backslash, colon,
control characters, invalid Unicode, `.git` components, wildcard syntax and outer
whitespace are refused. Names are not normalized or silently trimmed.

Rules are required exactly when this event is selected. Combining it with broad
`commit_changed` is refused. Context, finding and saved-turn events may be combined;
they are OR conditions and may wake the Pip independently of a path match. The
shared cooldown is 5–10,080 minutes. Calendars, Patch, Pulse and current-tree source
remain incompatible. Human authorship is required to introduce/change the filter;
model proposal/adaptation tools gain no new fields or authority. Configured-secret
collisions in authored rules/refs are refused before request redaction.

## Observation and source semantics

The controller resolves the currently approved local ref and compares two exact
commit trees. The observed commit pair is a wakeup reason. A run separately pins
the then-current approved source at enqueue; its source revision can differ from
the event's after-revision. Neither hash proves project correctness, ancestry,
test execution, or that all intermediate commits were observed.

The existing observer thread shares eight selections per tick across broad and
filtered commit modes. Each probe shares one three-second Git deadline, at most
1 MiB of captured metadata, 10,000 changed entries and 1,024 bytes per observed
path. No file body is read to decide a match. Git uses exact argv, no rename
heuristics/external diff/textconv/hooks/lazy fetch, and disabled network protocols.
No rule is passed to Git as an argument. Root identity is checked before/after;
these filesystem checks are observations, not an atomic OS snapshot or a hard
filesystem I/O deadline. Git/platform availability remains a runtime prerequisite.

A complete valid bounded comparison is required even when its first entry
matches. Missing objects, unavailable refs/roots, timeout, malformed metadata or
unsupported filenames produce no wakeup. The baseline and last successful
comparison remain intact; unknown endpoints stay null. A successful unmatched
comparison advances the baseline. First observation is silent. Unavailable
observations retry no faster than the normal thirty-second interval.

Pause/resume, archive/restore and global stop/resume discard pending events and
clear the baseline/diagnostics. Changes during those intervals do not become
surprise work after resumption. Reviewed rule/ref/binding changes silently
rebaseline. A name-only version may retain the baseline; new versions discard
old-version pending events and preserve the cooldown. Already-authorized automatic
name/ref adaptations follow those same rules without creating runs. Offline active
jobs coalesce retained events; busy/paused jobs retain existing consume-once skip
behavior. No historical backfill is inferred.

## Receipts, diagnostics and authority

`workspace_committed_paths_changed` is scoped to one Pip and workspace. Its closed
4 KiB payload contains job/binding/ref/filter identities, canonical observation
time and a bounded matched comparison with rule indices. It contains no discovered
filenames, source text, roots, credentials or transcripts. Payload observation time
equals the containing event timestamp. The retained controller-written event is
re-read under the queue transaction; caller claims or recomputed digests are not a
substitute. Event/cursor/run changes are atomic.

Only selection of this event adds `commit_path_match` to `manifest.event_trigger`.
Other selected events on the same policy omit it. The five-field occurrence and
its retry key stay unchanged. Quill's existing 4 KiB grant pins the policy without
duplicating the match; maximum rules fit the existing structural and byte limits.

Pure worker checks and bounded DB checks bind the receipt to the original immutable
definition/run before execution, successful admission and historical exposure.
Finding promotion and conversation report references apply the same original-run
check before presenting source-backed evidence.
They do not re-read today's source or require that the original event is still
retained. Failure/cancellation remains recordable when evidence is corrupt; no
successful result or partial source claim is manufactured. Exact retries return
the historical run without a new probe or cursor advance.

`get_pip` adds `commit_path_observation` for this mode only. It reports the baseline,
last probe, cumulative completed changed-commit observations, and separately dated
last successful comparison. Later unavailable probes do not refresh that historical
comparison's timestamp. Invalid/stale stored metadata produces a fixed unavailable
projection. Reading never probes Git or starts work. Counts are observations, not
matches, run counts, edits or success. Shared UI presents observed commits separately
from the run's actual pinned source.

The new SHA-256 domains are `dgc.pips.commit_paths.rules.v1\0`,
`dgc.pips.commit_paths.comparison.v1\0` and `dgc.pips.commit_paths.match.v1\0`.
Here `\0` means one NUL byte. Encoding uses sorted compact UTF-8 JSON without NaN,
normalization or a trailing newline. These are representation checks, not signed
attestations. An actor capable of arbitrary consistent SQLite forgery is outside
this provenance guarantee.

Schema22 creates one empty observer table/index. It performs no source scan,
baseline, event, run or historical rewrite. Existing policies and queued manifests
retain their bytes; legacy Quill grant bounds and all API21 Pulse behavior remain
unchanged. There is no new export/import authority, deletion policy, background
process, external service, or recurring model retry.

## Deterministic checks

`tests/test_pip_commit_paths.py` and `test_pip_commit_paths_parent.py` cover closed
metadata, literal rules, exact limits, real Git and original-version authority.
`tests/test_pip_commit_path_integration.py` covers reviewed activation, silent and
unmatched baselines, scoped events, retention/corruption refusal, shared fairness,
two-connection CAS, lifecycle/global-stop ABA, rollback, safe adaptation, no source
work on exact retry, separated observed/executed commits, diagnostic consistency,
CLI/secret bounds, historical context/reference refusal and maximum-rule Quill
execution with a mocked provider.
Legacy detector/event, Quill, final-answer and evidence-export regressions remain
part of the integration gate. These fixtures do not establish native model quality.

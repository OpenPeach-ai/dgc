# Reviewed adaptation policies

This increment is confined to the isolated Pips lab. It adds explicit policy selection and a separately permissioned main-chat tool for metadata edits. It does not give any Pip broader filesystem, execution, network, account or connector authority.

## Policy contract

`adaptation_policy` is immutable versioned job data:

| Mode | Model proposals | Automatic changes |
| --- | --- | --- |
| `locked` | Refused | Refused |
| `context_adaptive` | Refused | Refused; bounded reference context may still evolve independently |
| `suggest_changes` | Pending human review | Refused |
| `bounded_adaptive` | Pending human review | Explicitly selected nonempty subset of `name`, `source_ref` |
| `autonomous` | Pending human review | `name` and `source_ref` only |

Canonical shape is `{"mode":"bounded_adaptive","allowed_fields":["name"]}`. Field lists are unique and sorted. Fixed modes use an empty list, except autonomous which always has `["name","source_ref"]`. Existing fixed-mode strings remain readable; a bare legacy bounded mode cannot imply an allowlist and is refused.

New Pips still start with suggest_changes. Changing policy requires a normal human proposal and acceptance, not a create flag or a model tool. Even an apparently enabled policy cannot authorize an automatic change without a matching durable approved definition digest. Main-chat text, repository files, cached context and model prose cannot create that approval.

The original handoff's autonomous label is intentionally narrower here. Its separate requirement that goal changes need approval takes precedence. Goal, schedule/frequency, event triggers, model, tools, permissions, accounts, recipients and external actions always require human review. Autonomous does not mean unrestricted execution.

`source_ref` is an existing local committed Git reference selector, not an endpoint or repository location. Changing it may change the source selected by a later already-authorized run. The change neither fetches nor runs that source. The reviewed field selection should be understood accordingly.

## Controller and CLI

Human controls use existing `propose_pip_update` with `changes.adaptation_policy`, then `accept_pip_update` or `reject_pip_update`. The selected policy appears in the saved full definition under review. API 10 adds the read-only command:

```
list_pip_adaptations {pip_id, before_id?, limit?}
```

Default limit is 20, maximum 50. The cursor is a saved adaptation ID belonging to that Pip. Results include `adaptations` and `next_before_id`.

Local commands:

```
dgc pips adaptation PIP_ID --expected-version 3 --mode bounded_adaptive \
  --allow-field name --reason "Allow display-name maintenance"
dgc pips show PIP_ID
dgc pips accept PIP_ID PROPOSAL_ID --expected-version 3
dgc pips adaptations PIP_ID --limit 20
```

The adaptation command only proposes a policy. `--allow-field` is required for bounded mode and rejected for fixed modes. No CLI command bypasses the review by applying a model-origin automatic edit.

## Main-chat tool and permission checks

`pips_propose` remains proposal-only. Locked and context_adaptive refuse model-origin proposals. Suggest, bounded and autonomous can draft proposals, but models cannot accept them.

`pips_adapt` takes exactly:

```
{pip_id, expected_version, changes, reason, request_key}
```

`changes` contains only name and/or source_ref. Name is at most 120 characters; the source reference is at most 200 characters and has the same restricted local-ref grammar as ordinary Pips. Reason is at most 1,000 characters. Controls and malformed Unicode are refused; request encoding is bounded at 16 KiB. A retry key uses 1–64 ASCII letters, digits, underscores or hyphens. Configured secrets are redacted before validation and persistence; credentials are forbidden in identifiers.

The distinct permission label is `PipsAdapt`. It is not read-only and is not automatically approved by acceptEdits. Ordinary deny → ask → allow applies, including explicit denial in auto mode. Main-chat permission approval authorizes the tool call only; the Pip must independently carry reviewed adaptation authority. Child agents, monitor turns, disabled Pips, and foreground RuntimePolicy or sandbox sessions cannot use it. Pips' own worker tools remain confined and do not receive it. The existing native model loop advertises and executes it; there is no separate model implementation.

The owning workspace and session come from the server-owned main-chat context and private session registry. They cannot be supplied by model arguments. A different Pip/workspace or forged session mapping is refused.

## Persistence, retries and scheduling

Schema 9 adds append-only `pip_adaptations`, separate from human approvals. One transaction checks private scope, exact retry identity, expected job version, policy allowlist and the matching human approval. It then creates a new immutable job version, records the origin privately, and emits a metadata-change event. Stale pending proposals become superseded. It creates no new approval pretending that the user reviewed the exact automatic edit.

History records carry the Pip/workspace identity, from/to versions, the authorizing policy version and approval ID, canonical policy, changed fields, reason and timestamp. Origin session and retry keys stay private. History pages are bounded to 64 KiB, and the archive has a 10,000-record cap. Archive management is not implemented; reaching the cap refuses further automatic edits without changing the job.

Identical session/key/content retries return the saved receipt without another change, even after later versions or policy revocation. Reusing the key with different content fails. Concurrent different requests use version CAS; at most one wins. A no-op creates no version. A crash or failure during cursor, version or receipt writes rolls back the whole transaction.

An automatic edit never starts work, resumes a paused Pip, changes permissions, or resets a schedule anchor. Existing schedule and event cursors retain every field except their current job-version association. Commit observation retains its baseline for a name edit. A changed source_ref resets only the source observation to a silent first baseline; it does not emit a branch-change event or replay old events. Queued runs keep their original pinned job version.

## Verification

Deterministic tests cover policy grammar, human-approval authority, protected fields, exact retries, concurrent callers, source and session isolation, unchanged schedule/event cursors, paused status, commit rebaselining, rollback, schema migration, corrupt and oversized history, secret redaction, permission modes, foreground policy refusal, main-chat-only tool routing, the native local-model tool-call loop with a scripted provider, and the real console proposal/review flow. No tests use network requests or sleeps. Scripted provider tests establish harness integration, not quality or reliability of any particular model.

Live provider and frontend QA is recorded separately by the review owner. This document does not claim native model acceptance or visual verification of the policy UI.

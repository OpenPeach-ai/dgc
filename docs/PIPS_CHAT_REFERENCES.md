# Pip references in the main chat

The composer can select a Pip from the current chat workspace and retain its
identity as a reference. This is separate from persistent session attachments,
Pip conversation messages and execution requests. Selecting or sending a reference
does not start a Pip, approve anything, or expose another workspace.

`ready.capabilities.pip_references: 1` advertises this additive editor-protocol
feature. It does not change the Pips control API version. The picker sends
`list_prompt_pips` with a correlation ID and optional query, cursor and limit.
The backend supplies workspace scope from its own project root and chat session;
the caller cannot choose a workspace, binding or session. A prior session binding
must agree with the current directory. An unsaved chat may read that directory's
existing binding without creating an association.

Discovery returns only the workspace ID and Pip ID, name, type, status, job version
and lifecycle revision. Queries are at most 128 UTF-8 bytes; pages contain at most
20 rows, scanning at most the workspace's 100 Pip definitions. Definitions are
guarded at 24 KiB per SQL cell before decoding. A separate read-only SQLite snapshot
per request neither initializes/migrates storage nor reads transcript, report,
activity, source or artifact bodies. Names are redacted display labels, not trusted
instructions. Archived Pips remain referenceable as historical identities.

A prompt may carry one to eight distinct references:

```json
{"type":"prompt","request_id":"message-1","text":"Explain this Pip's work.",
 "pip_references":[{"pip_id":"pip_0123456789abcdef0123456789abcdef",
                    "expected_version":2,"expected_lifecycle_revision":3}]}
```

The owning backend validates every exact pin before reading image attachments or
acknowledging the message. Missing, stale, foreign or malformed references refuse
the entire prompt; the editor preserves its draft and selections. A fresh selection
is required after a job/lifecycle change. Goal shortcuts and question replies do
not accept references in this increment and refuse them explicitly in the UI.

The backend keeps its resolved metadata snapshot separately from caller-supplied
editor context through ordinary, queued and steered prompts, including deferred
steering fallback. Reference bytes count toward the queue budget. The model sees
a bounded, delimiter-escaped inert JSON frame. Later job changes do not rewrite
that accepted historical snapshot. Existing scoped read tools remain necessary
to inspect actual work; existing execution permissions remain necessary to act.

The editor preserves normal file mentions, keyboard navigation, selected chips and
rejected drafts. Discovery results are correlated to backend, chat and handshake
generation. Remote forwards only the closed reference fields and uses the same
owning-session validation. Restricted runtime-policy or sandboxed foreground
sessions refuse these independent-registry reads; child agents receive no new
scope or callback.

Saved model context contains the inert reference metadata. The ordinary history
projection strips that framing from displayed user prose; this increment does not
reconstruct trusted reference chips by parsing arbitrary saved transcript text.
These references are not signed evidence and do not attest a Pip's results.

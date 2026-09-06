# Read-only Git inspection

The native agent's `git_diff` tool works in every permission mode, including plan mode. It inspects
real local changes and reports incomplete coverage explicitly. `GitDiff` permission rules use the
same deny → ask → allow policy as other tools. A literal file or directory can narrow `path`; paths
outside the project require the normal external-directory permission and are unavailable in plan mode.

| View | Comparison |
| --- | --- |
| `uncommitted` (default) | HEAD → index, then index → working files, including untracked files |
| `staged` | HEAD → index; also works before the first commit |
| `working` | Index → working files, including non-ignored untracked files |
| `base`, with `ref` | Merge base of a local branch/tag/commit and HEAD → HEAD |
| `commit`, optional `ref` | First parent → one commit (default HEAD); root commits use an empty tree |

For example, `{"view":"base","ref":"main","path":"src"}` reviews committed branch changes
under `src`. Base/commit views do not include uncommitted edits. No view fetches remote changes.
For a merge commit, `commit` shows its difference from the first parent.

Git only enumerates index/tree entries and reads stored objects. Working files are read through DGC's
bounded workspace API and compared as raw bytes. DGC does not run clean/smudge filters, external diff
drivers, textconv programs, hooks, filesystem monitors, or network transports. This means checkout
line-ending conversion and other filters may produce differences from the ordinary Git UI. Renames
appear as deletion/addition. Symlinks, submodule contents, and conflicts require separate inspection.

Inspection has a 20-second deadline, a 4,096-file cap, 1 MiB per file/list, a 64 MiB aggregate file-read
budget, and a 24,000-character diff budget. A text diff allows 6,000 combined lines; individual lines
are capped at 2,000 characters. Cancellation and all truncation/skips are visible. Narrow the path or
read specific files when coverage is partial. "No changes" is returned only when the selected scope
was inspected completely and had no differences. Normal tool-output credential redaction applies.

The implementation follows the documented [Git object-reading interface](https://git-scm.com/docs/git-cat-file),
[index enumeration](https://git-scm.com/docs/git-ls-files), and
[transport/optional-lock controls](https://git-scm.com/docs/git). Git's diff filters are documented in
[git-diff](https://git-scm.com/docs/git-diff). Subscription CLIs use their own tools and permission boundaries;
they do not receive DGC's native tool registry.

## Editor change rail and previews

The editor uses the same bounded object/file reader for its automatic changed-file summary and
native diff previews. It does not run a separate Git executable or read file bodies in the webview.
The protocol-v6 `workspace_inspection` capability gates the correlated `get_workspace_changes` and
`get_workspace_change` requests. An older CLI shows an update notice instead of falling back to
ordinary Git diffs. Inspection is independent of the model turn and does not add file bodies to the
conversation or model input. Normal event credential redaction also applies to preview text.

The rail covers the currently acknowledged editor folders, including changes made before the chat.
It compares HEAD with working files and also retains staged-only changes. Line totals represent
the displayed working-file differences; a staged-only entry can therefore show zero net lines.
Opening that entry previews its index content in a diff titled **DGC staged review**. Other entries
preview HEAD against current working content. New repositories and untracked files use an empty
before side. Symlinks show link text, never target contents. Sparse-checkout omissions do not appear
as deletions. Binary, conflict, submodule and oversized previews direct the user to Source Control.

Inspection covers at most 16 folders, with one 20-second deadline and 500 displayed files across
them. Overlapping folders are counted once. Reports share a 2 MiB transport budget; each text-preview
side is limited to 256 KiB. Unknown line counts display a dash, with partial-coverage notices rather
than a clean-workspace claim. Folder changes revoke pending inspections; backend restarts reject
pending requests immediately. Opaque row identities distinguish identical filenames and folder
labels, and stale responses cannot open a preview after its workspace access changes.

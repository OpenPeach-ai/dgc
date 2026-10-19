"""Would a Pip's source fit a run? Checked up front, so nobody waits for a scheduled run to fail.

Uses exactly the selection a run uses (committed: the commit at the Pip's ref, listed but not
copied; current tree: an inventory without copying), so "fits" here means the run's copy will
fit unless the source changes first. Reads no file contents except ignore files.
"""
from __future__ import annotations

from . import pip_source_rules as rules
from .workspace_registry import RegistryError


def _folders(sizes):
    return [{'path': rules.display(p), 'bytes': b, 'files': n} for p, b, n in rules.biggest_folders(sizes)]


def check(registry, pip) -> dict:
    """{applies, fits, mode, rules, revision, files, bytes, limits, left_out, biggest_folders, message}."""
    from .pip_sources import validate_policy, rules as rules_of
    policy = validate_policy(pip.get('source_policy', 'committed_only'))
    if policy['mode'] == 'personal':
        return {'applies': False, 'fits': True, 'mode': 'personal', 'rules': None, 'revision': None, 'files': 0,
                'bytes': 0, 'limits': None, 'left_out': None, 'biggest_folders': [], 'message': None}
    name = rules_of(policy)
    v2 = name == rules.RULES_V2
    limits = ({'bytes': rules.MAX_BYTES, 'entries': rules.MAX_ENTRIES, 'file_bytes': rules.MAX_FILE_BYTES} if v2
              else {'bytes': 64 * rules.MiB, 'entries': 10000, 'file_bytes': rules.MAX_FILE_BYTES})
    result = {'applies': True, 'fits': True, 'mode': policy['mode'], 'rules': name, 'revision': None,
              'files': 0, 'bytes': 0, 'limits': limits, 'left_out': None, 'biggest_folders': [], 'message': None}
    root = registry.binding(pip['workspace_id'])['canonical_root']
    try:
        if policy['mode'] == 'committed_only':
            from . import pips
            result['revision'] = pips.source_revision(root, pip['source_ref'])
            if v2:
                rows, left = pips.committed_selection(root, result['revision'], policy)
                result['left_out'] = left.record()
            else:
                rows = pips._committed_files(root, result['revision'])
            sizes = [(path.as_posix(), size) for path, _, size in rows]
        else:
            from . import pip_tree_snapshot
            found = pip_tree_snapshot.inspect(root, policy)
            sizes, result['left_out'] = found['sizes'], found['left_out']
    except RegistryError as error:
        if error.code not in ('snapshot_limit', 'unsupported_source', 'unsafe_snapshot', 'empty_snapshot'):
            raise
        size = getattr(error, 'source_size', None) or {}
        result.update(fits=False, message=str(error), files=size.get('files', 0), bytes=size.get('bytes', 0),
                      biggest_folders=size.get('biggest_folders', []))
        return result
    result.update(files=len(sizes), bytes=sum(size for _, size in sizes), biggest_folders=_folders(sizes))
    return result


def summary(value) -> str:
    """One plain line for a tool result or the CLI."""
    if not value['applies']:
        return 'Personal Pips have no project source.'
    if not value['fits']:
        return value['message']
    text = (f"Fits: {value['files']:,} files, {rules.size_text(value['bytes'])} of the "
            f"{rules.size_text(value['limits']['bytes'])} limit ({value['rules']}).")
    left = value['left_out']
    if left and left['skipped_count']:
        text += f" {left['skipped_count']:,} files are skipped and listed with each run ({rules.size_text(left['skipped_bytes'])})."
    excluded = sum((left or {}).get('excluded_count', {}).values()) if left else 0
    if excluded:
        text += f' {excluded:,} entries are left out by the source rules, ignore files and Excluded folders.'
    return text

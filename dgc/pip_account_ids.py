"""Connected-account IDs returned by Composio, never aliases or email addresses."""
from __future__ import annotations

import re

# Older connections use ca_/coup_. Current tool-router search can return an
# opaque ID prefixed by its toolkit (for example gmail_...). Keep the prefix
# tied to the toolkit at discovery; later persisted receipts use this bounded
# syntax without trusting a mutable alias or a mailbox address as identity.
ACCOUNT_ID = re.compile(r'(?:ca|coup)_[A-Za-z0-9_-]{1,120}\Z|[a-z][a-z0-9]{1,39}_[A-Za-z0-9_-]{8,120}\Z')


def valid_account_id(value, toolkit: str | None = None) -> bool:
    if not isinstance(value, str) or not ACCOUNT_ID.fullmatch(value):
        return False
    return toolkit is None or value.startswith(('ca_', 'coup_', toolkit + '_'))

"""Deep research moved to dgc.deep_research: one module every surface shares (0.52). This name IS that module, so
ChatDGC, its tests and anything that patches research.<name> reach the one engine."""
import sys

from .. import deep_research as _shared

sys.modules[__name__] = _shared

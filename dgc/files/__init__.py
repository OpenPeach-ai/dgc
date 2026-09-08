"""The ``/files`` explorer: a dependency-free file manager that lives in DGC's focus pane while the
agent keeps working above it.

Every write goes through the workspace boundary, the permission mode, and a snapshot-backed undo;
nothing here runs a shell, and nothing enters the model's context unless the user inserts it.
"""
from .pane import FilesPane, FilesPaneError

__all__ = ["FilesPane", "FilesPaneError"]

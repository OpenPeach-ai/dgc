"""Remove later additive objects when constructing genuine older-schema fixtures."""

def drop_setup_schema(db):
    db.execute('DROP TABLE IF EXISTS pip_connector_drafts')
    db.execute('DROP TABLE IF EXISTS pip_calendar_drafts')
    db.execute('DROP TABLE IF EXISTS pip_message_drafts')
    db.execute('DROP TABLE IF EXISTS pip_app_actions')
    db.execute('DROP TABLE IF EXISTS pip_setup_proposals')

def drop_commit_path_schema(db):
    drop_setup_schema(db)
    db.execute('DROP TABLE IF EXISTS pip_commit_path_observations')

def drop_statement_schema(db):
    drop_commit_path_schema(db)
    db.execute('DROP TABLE IF EXISTS pip_memory_statements')

def drop_session_turn_schema(db):
    drop_statement_schema(db)
    # SQLite drops this table's scope index and immutable triggers with it.
    db.execute('DROP TABLE IF EXISTS session_turn_completions')

def drop_archive_schema(db):
    drop_session_turn_schema(db)
    for name in ('session_execution_finals','session_execution_attempts'):
        db.execute('DROP TABLE IF EXISTS '+name)
    for name in ('pip_lifecycle_created','pip_lifecycle_changed'):
        db.execute('DROP TRIGGER IF EXISTS '+name)
    for name in ('pip_archive_requests','pip_lifecycle_state'):
        db.execute('DROP TABLE IF EXISTS '+name)

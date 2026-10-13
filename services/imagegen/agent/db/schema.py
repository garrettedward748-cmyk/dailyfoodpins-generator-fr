"""SQLite schema — async via aiosqlite.

One table. This service exists to turn a prompt into an image URL, and a job
row is the whole of that: what was asked for, how it went, and where the
result lives.

The version this replaced modelled a video production pipeline — projects
holding videos holding scenes holding requests — and /v1 had to fabricate a
singleton project and video on every call just to have somewhere to hang a
scene. That scaffolding held up nothing once the video half was removed.
"""
import asyncio
import logging

import aiosqlite

from agent.config import DB_PATH

logger = logging.getLogger(__name__)

_db_connection: aiosqlite.Connection | None = None
_db_lock = asyncio.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS job (
    id            TEXT PRIMARY KEY,
    prompt        TEXT NOT NULL,
    orientation   TEXT NOT NULL DEFAULT 'VERTICAL'
                  CHECK(orientation IN ('VERTICAL','HORIZONTAL')),

    -- Sent to Google as clientContext.projectId. Per job, not per container:
    -- one image service serves every site and each site has its own Flow
    -- project, so a value baked into the environment could only ever be
    -- right for one of them.
    project_id    TEXT NOT NULL DEFAULT '',

    -- Which image model, as chosen on the platform's Settings page: one of
    -- the model keys, or 'auto' for Pro first and the others as fallbacks.
    image_model   TEXT NOT NULL DEFAULT 'auto',

    -- 'image' or 'video'. Defaulted so every row written before video existed
    -- reads back correctly, and so the image path needs no changes at all.
    kind          TEXT NOT NULL DEFAULT 'image'
                  CHECK(kind IN ('image','video')),

    -- Video only: the source images to compose from, and the Flow operation
    -- handed back at submit time that the worker polls until it resolves.
    reference_urls TEXT NOT NULL DEFAULT '[]',
    operation_json TEXT,

    status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK(status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
    media_id      TEXT,
    output_url    TEXT,
    error_message TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_job_status ON job(status, created_at);
"""


async def get_db() -> aiosqlite.Connection:
    """The shared connection, opened on first use."""
    global _db_connection

    if _db_connection is None:
        async with _db_lock:
            if _db_connection is None:
                DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                _db_connection = await aiosqlite.connect(DB_PATH)
                _db_connection.row_factory = aiosqlite.Row
                await _db_connection.execute("PRAGMA journal_mode = WAL")
                await _db_connection.execute("PRAGMA foreign_keys = ON")
                await _db_connection.execute("PRAGMA busy_timeout = 5000")
                await _db_connection.commit()

    return _db_connection


# Columns added to a table that already exists.
#
# SCHEMA is CREATE TABLE IF NOT EXISTS, which does nothing to a table that is
# already there — so a column added to the definition never reaches a database
# from an earlier deploy. The symptom is not a migration error but a KeyError
# at run time on a column the code is sure exists.
#
# Adding a column is the one change safe to apply automatically: it cannot lose
# data and it cannot fail on a second run.
ADDED_COLUMNS = [
    ("job", "project_id", "TEXT NOT NULL DEFAULT ''"),
    # Video, added alongside images rather than in a table of its own: a job is
    # still "a prompt went to Flow and something came back", and the queue,
    # retry, stale-reset and watchdog logic are all worth having once.
    ("job", "kind", "TEXT NOT NULL DEFAULT 'image'"),
    # The presenter a clip is composed with: a character and a voice, both
    # assets in the Flow project. NULL for a clip with nobody in it, and for
    # every image job.
    ("job", "character_media_id", "TEXT"),
    ("job", "voice_media_id", "TEXT"),
    ("job", "reference_urls", "TEXT NOT NULL DEFAULT '[]'"),
    ("job", "operation_json", "TEXT"),
    ("job", "image_model", "TEXT NOT NULL DEFAULT 'auto'"),
]


async def _add_missing_columns(db) -> None:
    for table, column, definition in ADDED_COLUMNS:
        async with db.execute(f"PRAGMA table_info({table})") as cursor:
            columns = [row["name"] for row in await cursor.fetchall()]

        # Empty means the table does not exist yet, in which case SCHEMA has
        # just created it with the column already present.
        if not columns or column in columns:
            continue

        await db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        logger.info("Added %s.%s to an existing database", table, column)

    await db.commit()


async def init_db() -> None:
    db = await get_db()
    await db.executescript(SCHEMA)
    await db.commit()
    await _add_missing_columns(db)
    logger.info("Database ready at %s", DB_PATH)


async def close_db() -> None:
    global _db_connection

    if _db_connection is not None:
        await _db_connection.close()
        _db_connection = None

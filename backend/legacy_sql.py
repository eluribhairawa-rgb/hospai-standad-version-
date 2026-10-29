"""
Thin compatibility layer so the small set of complex, multi-table
aggregate queries (dashboard analytics, revenue/report summaries,
pharmacy/supplier ledgers, etc.) can keep their original, already-correct
SQL almost unchanged, while running through the FastAPI-injected
SQLAlchemy `Session` (never a separate connection) as `db.execute(text(...))`.

Simple per-table CRUD lives directly in the routers as real
`db.query(Model)` ORM code - this module is only for the handful of
functions where re-deriving hand-written multi-join SQL into pure ORM
would risk changing behaviour.

Usage mirrors the old psycopg2-cursor style the original codebase used
(same '?' placeholders, same row['col'] / row[0] access, same
`.lastrowid` semantics for INSERT), so the original query bodies can be
pasted in with minimal changes.
"""
from contextlib import contextmanager

from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import Session

from database import DEFER_COMMIT_KEY


class RowProxy:
    __slots__ = ("_values", "_columns", "_index")

    def __init__(self, values, columns):
        self._values = tuple(values)
        self._columns = tuple(columns)
        self._index = {name: idx for idx, name in enumerate(self._columns)}

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return self._values[self._index[key]]

    def get(self, key, default=None):
        if key not in self._index:
            return default
        return self._values[self._index[key]]

    def items(self):
        return [(name, self._values[idx]) for idx, name in enumerate(self._columns)]

    def keys(self):
        return self._columns

    def __iter__(self):
        return iter(self._values)

    def __repr__(self):
        return f"RowProxy({dict(self.items())!r})"


def _positional_to_named(sql: str, params):
    """Convert '?' positional placeholders to :p0, :p1... named params."""
    if not params:
        return sql, {}
    out = []
    pdict = {}
    pi = 0
    for ch in sql:
        if ch == "?":
            key = f"p{pi}"
            pdict[key] = params[pi]
            out.append(f":{key}")
            pi += 1
        else:
            out.append(ch)
    return "".join(out), pdict


class LegacyResult:
    """Wraps a SQLAlchemy CursorResult to mimic the old psycopg2 cursor API."""

    def __init__(self, result, lastrowid=None):
        self._result = result
        self._lastrowid = lastrowid
        self._keys = None
        try:
            self._keys = list(result.keys())
        except Exception:
            self._keys = []

    def fetchone(self):
        row = self._result.fetchone()
        if row is None:
            return None
        return RowProxy(tuple(row), self._keys)

    def fetchall(self):
        return [RowProxy(tuple(row), self._keys) for row in self._result.fetchall()]

    @property
    def lastrowid(self):
        return self._lastrowid

    @property
    def rowcount(self):
        return self._result.rowcount


def run(db: Session, sql: str, params=None) -> LegacyResult:
    """Execute a legacy '?'-placeholder SQL statement through the session.

    INSERT statements without an explicit RETURNING clause automatically
    get " RETURNING id" appended (same behaviour the original app relied
    on), so `.lastrowid` keeps working for callers migrated unchanged.
    """
    named_sql, pdict = _positional_to_named(sql, params)
    stripped = named_sql.strip()
    is_insert = stripped.upper().startswith("INSERT") and "RETURNING" not in stripped.upper()

    if is_insert:
        sql_with_returning = stripped.rstrip().rstrip(";") + " RETURNING id"
        try:
            # Savepoint: if the table has no 'id' column only this statement is
            # undone, not the earlier work of the surrounding transaction.
            with db.begin_nested():
                result = db.execute(text(sql_with_returning), pdict)
                lastrowid = None
                try:
                    row = result.fetchone()
                    if row is not None:
                        lastrowid = row[0]
                except Exception:
                    pass
            return LegacyResult(result, lastrowid=lastrowid)
        except ProgrammingError as exc:
            # Table may not have an 'id' column - fall back without RETURNING.
            # Any other failure (unique/foreign-key violation, bad value...) is
            # real and must reach the caller instead of being retried.
            if 'column "id" does not exist' not in str(exc):
                raise

    result = db.execute(text(named_sql), pdict)
    return LegacyResult(result)


def one(db: Session, sql: str, params=None):
    return run(db, sql, params).fetchone()


def all_(db: Session, sql: str, params=None):
    return run(db, sql, params).fetchall()


# ---------------------------------------------------------------------------
# psycopg2-cursor-shaped shim, so the ported legacy_queries.py function
# bodies (originally written against `with get_connection() as conn: cursor
# = conn.cursor(); cursor.execute(...)`) work completely unchanged apart from
# `get_connection()` -> `get_connection(db)`. Every statement still goes
# through the one injected `db` session - this is not a second connection.
# ---------------------------------------------------------------------------

class _CompatCursor:
    def __init__(self, db: Session):
        self.db = db
        self._last: LegacyResult | None = None

    def execute(self, sql, params=None):
        self._last = run(self.db, sql, params)
        return self._last

    def executemany(self, sql, seq_of_params):
        last = None
        for params in seq_of_params:
            last = run(self.db, sql, params)
        self._last = last
        return last

    def fetchone(self):
        return self._last.fetchone() if self._last is not None else None

    def fetchall(self):
        return self._last.fetchall() if self._last is not None else []

    @property
    def lastrowid(self):
        return self._last.lastrowid if self._last is not None else None

    @property
    def rowcount(self):
        return self._last.rowcount if self._last is not None else -1


class _CompatConn:
    def __init__(self, db: Session):
        self.db = db

    def cursor(self):
        return _CompatCursor(self.db)

    def commit(self):
        # Sessions from database.get_audited_db() commit once, together with the audit row.
        if self.db.info.get(DEFER_COMMIT_KEY):
            self.db.flush()
        else:
            self.db.commit()

    def rollback(self):
        self.db.rollback()


@contextmanager
def get_connection(db: Session):
    """Drop-in replacement for the original `get_connection()` context
    manager, bound to the FastAPI-injected session instead of opening a
    new psycopg2 connection."""
    yield _CompatConn(db)

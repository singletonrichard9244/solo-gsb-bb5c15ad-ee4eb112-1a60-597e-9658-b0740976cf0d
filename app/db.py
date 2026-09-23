"""Async SQLite storage: plays and their append-only operation logs."""
from __future__ import annotations

import asyncio
import json
import os
import time

import aiosqlite

DB_PATH = os.environ.get("REHEARSAL_DB", "/data/rehearsal.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS plays (
    play_id     TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    created_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS ops (
    play_id  TEXT NOT NULL,
    op_id    TEXT NOT NULL,
    op       TEXT NOT NULL,
    seq      INTEGER NOT NULL,
    PRIMARY KEY (play_id, op_id)
);
CREATE INDEX IF NOT EXISTS idx_ops_play ON ops(play_id, seq);
"""


class Database:
    def __init__(self, path: str = DB_PATH):
        self.path = path
        self._seq: dict[str, int] = {}
        # a single connection: serialize writes so one coroutine's insert
        # can't be rolled back by another's duplicate-insert handling
        self._write_lock = asyncio.Lock()

    async def connect(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        self.conn = await aiosqlite.connect(self.path)
        await self.conn.execute("PRAGMA journal_mode=WAL")
        await self.conn.execute("PRAGMA foreign_keys=ON")
        await self.conn.executescript(_SCHEMA)
        await self.conn.commit()
        async with self.conn.execute(
            "SELECT play_id, COALESCE(MAX(seq), 0) FROM ops GROUP BY play_id"
        ) as cur:
            for play_id, seq in await cur.fetchall():
                self._seq[play_id] = seq

    async def close(self) -> None:
        await self.conn.close()

    # ---- plays -------------------------------------------------------------
    async def create_play(self, play_id: str, title: str) -> None:
        async with self._write_lock:
            await self.conn.execute(
                "INSERT OR IGNORE INTO plays(play_id, title, created_at) VALUES (?,?,?)",
                (play_id, title, time.time()),
            )
            await self.conn.commit()
        self._seq.setdefault(play_id, 0)

    async def ensure_play(self, play_id: str, title: str = "未命名剧目") -> bool:
        """Create the play if missing; return True if it was created."""
        async with self.conn.execute(
            "SELECT 1 FROM plays WHERE play_id=?", (play_id,)
        ) as cur:
            if await cur.fetchone():
                return False
        await self.create_play(play_id, title)
        return True

    async def list_plays(self) -> list[dict]:
        async with self.conn.execute(
            "SELECT play_id, title, created_at FROM plays ORDER BY created_at DESC"
        ) as cur:
            rows = await cur.fetchall()
        return [{"playId": p, "title": t, "createdAt": c} for p, t, c in rows]

    async def play_title(self, play_id: str) -> str | None:
        async with self.conn.execute(
            "SELECT title FROM plays WHERE play_id=?", (play_id,)
        ) as cur:
            row = await cur.fetchone()
        return row[0] if row else None

    async def rename_play(self, play_id: str, title: str) -> None:
        async with self._write_lock:
            await self.conn.execute(
                "UPDATE plays SET title=? WHERE play_id=?", (title, play_id)
            )
            await self.conn.commit()

    # ---- operations --------------------------------------------------------
    async def append_op(self, play_id: str, op: dict) -> bool:
        """Append an op. Returns False if its opId already exists."""
        async with self._write_lock:
            self._seq[play_id] = self._seq.get(play_id, 0) + 1
            cur = await self.conn.execute(
                "INSERT OR IGNORE INTO ops(play_id, op_id, op, seq) VALUES (?,?,?,?)",
                (play_id, op["opId"], json.dumps(op, ensure_ascii=False),
                 self._seq[play_id]),
            )
            await self.conn.commit()
            if cur.rowcount == 0:
                # duplicate opId: release the consumed seq number
                self._seq[play_id] -= 1
                return False
            return True

    async def append_ops_bulk(self, play_id: str, ops: list[dict]) -> list[dict]:
        """Append many ops under one transaction, skipping duplicates."""
        inserted: list[dict] = []
        async with self._write_lock:
            for op in ops:
                self._seq[play_id] = self._seq.get(play_id, 0) + 1
                cur = await self.conn.execute(
                    "INSERT OR IGNORE INTO ops(play_id, op_id, op, seq) VALUES (?,?,?,?)",
                    (play_id, op["opId"], json.dumps(op, ensure_ascii=False),
                     self._seq[play_id]),
                )
                if cur.rowcount > 0:
                    inserted.append(op)
                else:
                    self._seq[play_id] -= 1
            await self.conn.commit()
        return inserted

    async def load_ops(self, play_id: str, after_vv: dict | None = None) -> list[dict]:
        """Load ops in insertion order; with after_vv return only unseen ones.

        An op emitted by client C with per-client sequence S is considered seen
        when after_vv[C] >= S (the VV the op was emitted under dominates it).
        """
        async with self.conn.execute(
            "SELECT op FROM ops WHERE play_id=? ORDER BY seq", (play_id,)
        ) as cur:
            rows = await cur.fetchall()
        ops = [json.loads(r[0]) for r in rows]
        if after_vv is None:
            return ops

        def _seq(op: dict) -> int:
            return int(str(op["opId"]).split("@", 1)[0])

        return [o for o in ops if int(after_vv.get(o["clientId"], 0)) < _seq(o)]

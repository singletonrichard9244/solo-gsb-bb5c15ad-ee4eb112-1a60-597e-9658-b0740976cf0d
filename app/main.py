"""FastAPI application: REST API, JSON import/export, WebSocket, static UI."""
from __future__ import annotations

import json
import os
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .db import Database
from .engine import snapshot as build_snapshot
from .ws import Manager, validate_op

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")

db = Database()
manager = Manager(db)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    await manager.start()
    try:
        yield
    finally:
        await manager.stop()
        await db.close()


app = FastAPI(title="Rehearsal Timeline", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------- models ----
class PlayIn(BaseModel):
    title: str = Field(default="未命名剧目", max_length=120)


class RenameIn(BaseModel):
    title: str = Field(max_length=120)


def _import_op(raw: dict, server_lamport: int, index: int) -> dict:
    """Re-stamp an imported op so it merges safely into an existing log."""
    err = validate_op(raw)
    if err:
        raise HTTPException(400, f"非法操作 {raw.get('opId')}: {err}")
    op = {
        "opId": raw["opId"],
        "type": raw["type"],
        "kind": raw["kind"],
        "elemId": raw["elemId"],
        "lamport": int(raw["lamport"]) + server_lamport + index + 1,
        "clientId": raw["clientId"],
        "vv": {str(k): int(v) for k, v in (raw.get("vv") or {}).items()},
        "payload": raw.get("payload") or {},
    }
    if raw.get("parent") is not None:
        op["parent"] = raw["parent"]
    return op


# ------------------------------------------------------------------ REST ----
@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "ts": time.time()}


@app.get("/api/plays")
async def list_plays() -> list[dict]:
    return await db.list_plays()


@app.post("/api/plays", status_code=201)
async def create_play(body: PlayIn) -> dict:
    play_id = uuid.uuid4().hex[:12]
    await db.create_play(play_id, body.title)
    return {"playId": play_id, "title": body.title}


@app.get("/api/plays/{play_id}/export")
async def export_play(play_id: str) -> dict:
    title = await db.play_title(play_id)
    if title is None:
        raise HTTPException(404, "剧目不存在")
    ops = await db.load_ops(play_id)
    snap = build_snapshot(ops)
    return {
        "format": "rehearsal-timeline/v1",
        "playId": play_id,
        "title": title,
        "exportedAt": time.time(),
        "timeUnit": "ms",
        "snapshot": snap["view"],
        "operations": ops,
    }


def _op_signature(op: dict) -> str:
    """Semantic identity of an op excluding clock metadata.

    Two ops with the same opId but a different signature come from different
    plays (opId sequences restart at 1 per client per play) and must not be
    silently treated as duplicates.
    """
    core = {k: v for k, v in op.items() if k not in ("lamport", "vv")}
    return json.dumps(core, sort_keys=True, ensure_ascii=False)


@app.post("/api/plays/{play_id}/import")
async def import_play(play_id: str, doc: dict) -> dict:
    """Merge a JSON document into the play's log.

    Accepts either an export document (``operations`` list) or a bare
    ``{operations: [...]}`` payload.  Imported lamps are shifted above the
    current server lamport so they behave as fresh concurrent writes.
    Re-importing the same document is idempotent; importing a *different*
    play whose ops share opIds is rejected with 409.
    """
    if not isinstance(doc, dict) or not isinstance(doc.get("operations"), list):
        raise HTTPException(400, "文档格式错误：缺少 operations 数组")
    if doc.get("format") and doc["format"] != "rehearsal-timeline/v1":
        raise HTTPException(400, "不支持的导出格式版本")

    await db.ensure_play(play_id, str(doc.get("title") or "导入的剧目")[:120])

    existing = await db.load_ops(play_id)
    server_lamport = max([int(o["lamport"]) for o in existing] + [0])
    by_id = {o["opId"]: o for o in existing}
    prepared = []
    skipped = 0
    for i, raw in enumerate(doc["operations"]):
        op = _import_op(raw, server_lamport, i)
        prior = by_id.get(op["opId"])
        if prior is not None:
            if _op_signature(prior) == _op_signature(op):
                skipped += 1  # already imported from the same document
                continue
            raise HTTPException(
                409,
                f"操作 {op['opId']} 在目标剧目中指向不同内容——该文档似乎来自"
                "另一剧目，请改用「导入为新剧目」",
            )
        prepared.append(op)

    inserted = await db.append_ops_bulk(play_id, prepared)
    for op in inserted:
        await manager._send_to_room(play_id, {"type": "op", "op": op})
    return {"imported": len(inserted), "skipped": skipped}


@app.post("/api/import", status_code=201)
async def import_new_play(doc: dict) -> dict:
    """Create a brand-new play from an export document."""
    if not isinstance(doc, dict) or not isinstance(doc.get("operations"), list):
        raise HTTPException(400, "文档格式错误：缺少 operations 数组")
    if doc.get("format") and doc["format"] != "rehearsal-timeline/v1":
        raise HTTPException(400, "不支持的导出格式版本")

    play_id = uuid.uuid4().hex[:12]
    title = str(doc.get("title") or "导入的剧目")[:120]
    await db.create_play(play_id, title)

    server_lamport = 0
    prepared = [_import_op(raw, server_lamport, i)
                for i, raw in enumerate(doc["operations"])]
    inserted = await db.append_ops_bulk(play_id, prepared)
    return {"playId": play_id, "title": title, "imported": len(inserted)}


@app.get("/api/plays/{play_id}/state")
async def play_state(play_id: str) -> dict:
    if await db.play_title(play_id) is None:
        raise HTTPException(404, "剧目不存在")
    ops = await db.load_ops(play_id)
    return build_snapshot(ops)


@app.patch("/api/plays/{play_id}")
async def rename_play(play_id: str, body: RenameIn) -> dict:
    if await db.play_title(play_id) is None:
        raise HTTPException(404, "剧目不存在")
    await db.rename_play(play_id, body.title)
    return {"playId": play_id, "title": body.title}


@app.websocket("/ws/{play_id}")
async def websocket_endpoint(ws: WebSocket, play_id: str) -> None:
    await manager.handle(ws, play_id)


# ---------------------------------------------------------------- static ----
if os.path.isdir(STATIC_DIR):
    # /static/* for the asset URLs hard-coded in index.html; "/" serves the
    # page itself at the root (mounted after all /api and /ws routes)
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static-assets")
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static-root")

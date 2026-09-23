"""WebSocket connection manager: live presence, fan-out and snapshots."""
from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import WebSocket

from .db import Database
from .engine import client_seq, snapshot as build_snapshot

# op field validation
_OP_TYPES = {"add", "move", "rename", "delete", "restore"}
_KINDS = {"scene", "action", "sound"}
_FIELDS = {
    "scene": {"name", "start", "duration"},
    "action": {"name", "start", "duration", "parent"},
    "sound": {"name", "start", "duration"},
}
# clientIds pruned from presence after this long without a ping
_STALE_AFTER = 30.0
_PING_INTERVAL = 10.0


def validate_op(op: Any) -> str | None:
    """Return an error message if the op is malformed, else None."""
    if not isinstance(op, dict):
        return "op must be an object"
    for key in ("opId", "type", "kind", "elemId", "lamport", "clientId", "vv"):
        if key not in op:
            return f"missing field: {key}"
    if op["type"] not in _OP_TYPES:
        return "bad type"
    if op["kind"] not in _KINDS:
        return "bad kind"
    if "@" not in str(op["opId"]):
        return "bad opId"
    try:
        int(op["lamport"])
    except (TypeError, ValueError):
        return "bad lamport"
    if not isinstance(op.get("vv"), dict):
        return "bad vv"

    payload = op.get("payload") or {}
    if op["type"] == "add":
        if not isinstance(payload, dict) or "name" not in payload:
            return "add needs payload.name"
        if not isinstance(payload.get("name"), str):
            return "bad name"
        if op["kind"] == "action" and not op.get("parent"):
            return "action needs parent"
    elif op["type"] in ("move", "rename"):
        if not isinstance(payload, dict) or not payload:
            return "move/rename needs payload"
        allowed = _FIELDS[op["kind"]]
        for k, v in payload.items():
            if k not in allowed:
                return f"field not allowed: {k}"
            if k in ("start", "duration"):
                if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                    return f"{k} must be a non-negative integer"
            elif k in ("name", "parent"):
                if not isinstance(v, str) or not v:
                    return f"{k} must be a non-empty string"
    return None


class Client:
    def __init__(self, ws: WebSocket, client_id: str, name: str, color: str):
        self.ws = ws
        self.client_id = client_id
        self.name = name
        self.color = color
        self.last_seen = time.time()

    def presence(self) -> dict:
        return {
            "clientId": self.client_id,
            "name": self.name,
            "color": self.color,
            "lastSeen": self.last_seen,
        }


class Manager:
    """One manager instance; rooms are keyed by play_id."""

    def __init__(self, db: Database):
        self.db = db
        self.rooms: dict[str, dict[str, Client]] = {}  # play -> clientId -> Client
        self.loop: asyncio.AbstractEventLoop | None = None
        self._pruner: asyncio.Task | None = None

    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self._pruner = asyncio.create_task(self._prune_stale())

    async def stop(self) -> None:
        if self._pruner:
            self._pruner.cancel()

    # ---- presence ----------------------------------------------------------
    def _presence_list(self, play_id: str) -> list[dict]:
        return [c.presence() for c in self.rooms.get(play_id, {}).values()]

    async def _broadcast_presence(self, play_id: str) -> None:
        msg = {"type": "presence", "members": self._presence_list(play_id)}
        await self._send_to_room(play_id, msg)

    async def _send_to_room(self, play_id: str, msg: dict,
                            exclude: str | None = None) -> None:
        dead: list[str] = []
        for cid, client in list(self.rooms.get(play_id, {}).items()):
            if cid == exclude:
                continue
            try:
                await client.ws.send_json(msg)
            except Exception:
                # only drop if this stale object still owns the slot — a
                # reconnecting client may already hold a new Client there
                if self.rooms.get(play_id, {}).get(cid) is client:
                    dead.append(cid)
        for cid in dead:
            self.rooms.get(play_id, {}).pop(cid, None)
        if dead:
            await self._broadcast_presence(play_id)

    async def _prune_stale(self) -> None:
        while True:
            await asyncio.sleep(_PING_INTERVAL)
            now = time.time()
            touched: set[str] = set()
            for play_id, clients in list(self.rooms.items()):
                stale = [
                    cid for cid, c in clients.items()
                    if now - c.last_seen > _STALE_AFTER
                ]
                for cid in stale:
                    clients.pop(cid, None)
                    touched.add(play_id)
            for play_id in touched:
                await self._broadcast_presence(play_id)

    # ---- session -----------------------------------------------------------
    async def handle(self, ws: WebSocket, play_id: str) -> None:
        await ws.accept()
        client: Client | None = None
        pinger: asyncio.Task | None = None
        try:
            # first frame must be hello
            first = await ws.receive_json()
            if first.get("type") != "hello":
                await ws.close(code=4400)
                return
            client_id = str(first.get("clientId") or "")
            name = str(first.get("name") or "匿名成员")[:24]
            color = str(first.get("color") or "#6366f1")
            vv = first.get("vv") if isinstance(first.get("vv"), dict) else {}
            if not client_id:
                await ws.close(code=4400)
                return
            if await self.db.play_title(play_id) is None:
                await self.db.ensure_play(play_id)

            client = Client(ws, client_id, name, color)
            room = self.rooms.setdefault(play_id, {})
            room[client_id] = client

            # hello reply: incremental snapshot since the client's VV.
            # vv is always the authoritative server VV: the client uses it to
            # know which of its locally queued ops have durably landed.
            all_ops = await self.db.load_ops(play_id)
            missing = await self.db.load_ops(play_id, vv)
            await ws.send_json({
                "type": "snapshot",
                "vv": build_snapshot(all_ops)["vv"],
                "ops": missing,
                "full": not bool(vv),
            })
            await self._broadcast_presence(play_id)
            pinger = asyncio.create_task(self._ping(client))

            while True:
                data = await ws.receive_json()
                client.last_seen = time.time()
                mtype = data.get("type")

                if mtype == "ping":
                    await ws.send_json({"type": "pong", "t": data.get("t")})

                elif mtype == "snapshot":
                    all_ops = await self.db.load_ops(play_id)
                    ops = await self.db.load_ops(
                        play_id,
                        data.get("vv") if isinstance(data.get("vv"), dict) else {},
                    )
                    await ws.send_json({
                        "type": "snapshot",
                        "ops": ops,
                        "vv": build_snapshot(all_ops)["vv"],
                        "full": False,
                    })

                elif mtype == "op":
                    op = data.get("op")
                    err = validate_op(op)
                    if err:
                        await ws.send_json({
                            "type": "op-rejected",
                            "opId": (op or {}).get("opId"),
                            "error": err,
                        })
                        continue
                    # only accept ops attributed to the connected client
                    if op["clientId"] != client_id:
                        await ws.send_json({
                            "type": "op-rejected",
                            "opId": op.get("opId"),
                            "error": "clientId mismatch",
                        })
                        continue
                    if await self.db.append_op(play_id, op):
                        # fan out to peers (sender excluded: it gets an ack)
                        await self._send_to_room(
                            play_id, {"type": "op", "op": op},
                            exclude=client_id,
                        )
                        await ws.send_json({"type": "op-ack", "opId": op["opId"]})

                elif mtype == "profile":
                    client.name = str(data.get("name") or client.name)[:24]
                    if data.get("color"):
                        client.color = str(data["color"])
                    await self._broadcast_presence(play_id)

        except Exception:
            pass  # disconnect / malformed frame -> cleanup
        finally:
            if pinger:
                pinger.cancel()
            if client is not None:
                room = self.rooms.get(play_id, {})
                if room.get(client.client_id) is client:
                    room.pop(client.client_id, None)
                await self._broadcast_presence(play_id)

    async def _ping(self, client: Client) -> None:
        try:
            while True:
                await asyncio.sleep(_PING_INTERVAL)
                await client.ws.send_json({"type": "ping"})
        except Exception:
            return

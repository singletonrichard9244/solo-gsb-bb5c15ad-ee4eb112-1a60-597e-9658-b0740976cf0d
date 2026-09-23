"""End-to-end: REST, WebSocket fan-out, offline queue replay, convergence."""
import os
import tempfile
import uuid

import pytest
from fastapi.testclient import TestClient

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["REHEARSAL_DB"] = _tmp.name

from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _op(seq, cid, typ, kind, elem, lamport, vv=None, payload=None, parent=None):
    o = {
        "opId": f"{seq}@{cid}", "type": typ, "kind": kind, "elemId": elem,
        "lamport": lamport, "clientId": cid, "vv": vv or {},
        "payload": payload or {},
    }
    if parent is not None:
        o["parent"] = parent
    return o


def _hello(ws, cid, vv=None, name=None):
    _INBOX.pop(id(ws), None)  # id() may be reused after a connection closes
    ws.send_json({"type": "hello", "clientId": cid,
                  "name": name or cid, "color": "#fff", "vv": vv or {}})
    return _recv_until(ws, "snapshot")


def _drain(ws, seconds=0.8):
    """Collect whatever frames arrive within a window (arrival order varies).

    TestClient's receive_json blocks forever, so poll its send queue
    non-blockingly and sleep briefly between attempts.
    """
    import json as _json
    import queue as _queue
    import time
    out = []
    end = time.time() + seconds
    q = ws._send_queue
    while time.time() < end:
        try:
            message = q.get_nowait()
        except _queue.Empty:
            time.sleep(0.05)
            continue
        if message.get("type") != "websocket.send":
            continue
        if "text" in message:
            out.append(_json.loads(message["text"]))
        elif "bytes" in message:
            out.append(_json.loads(message["bytes"]))
    return out


def _types(msgs):
    return [m["type"] for m in msgs]


# per-connection inbox so non-target frames aren't discarded
_INBOX = {}


def _recv_until(ws, mtype, timeout=3):
    import time
    box = _INBOX.setdefault(id(ws), [])
    end = time.time() + timeout
    last = None
    while time.time() < end:
        # 1. anything already buffered?
        for i, msg in enumerate(box):
            last = msg
            if msg["type"] == mtype:
                return box.pop(i)
        # 2. fetch one new frame (TestClient blocks until a frame arrives)
        try:
            msg = ws.receive_json()
        except Exception:
            break
        last = msg
        if msg["type"] == mtype:
            return msg
        box.append(msg)
    raise AssertionError(f"no {mtype} within {timeout}s (last={last})")


def test_rest_and_ws_concurrent_move_converge(client):
    # create play
    r = client.post("/api/plays", json={"title": "集成测试剧目"})
    assert r.status_code == 201
    pid = r.json()["playId"]

    with client.websocket_connect(f"/ws/{pid}") as wa, \
         client.websocket_connect(f"/ws/{pid}") as wb:
        _hello(wa, "clientA")
        _hello(wb, "clientB")

        # presence broadcast after both joined
        msg = _recv_until(wa, "presence")
        assert len(msg["members"]) >= 1

        # A creates a scene
        add = _op(1, "clientA", "add", "scene", "e1", 1,
                  {"clientA": 0},
                  {"name": "开场", "start": 0, "duration": 10000})
        wa.send_json({"type": "op", "op": add})
        assert _recv_until(wa, "op-ack")["opId"] == "1@clientA"
        relayed = _recv_until(wb, "op")["op"]
        assert relayed["opId"] == "1@clientA"

        # concurrent moves: both saw only the add (vv A:1)
        ma = _op(2, "clientA", "move", "scene", "e1", 2,
                 {"clientA": 1}, {"start": 10000})
        mb = _op(1, "clientB", "move", "scene", "e1", 2,
                 {"clientA": 1, "clientB": 0}, {"start": 20000})
        wa.send_json({"type": "op", "op": ma})
        wb.send_json({"type": "op", "op": mb})

        # collect the resulting frames (arrival order varies under the
        # in-process event loop): each sender must see its own ack and the
        # peer's move, never its own move echoed back as a broadcast
        frames_a = _drain(wa)
        frames_b = _drain(wb)
        ack_a = [m for m in frames_a if m["type"] == "op-ack"]
        ack_b = [m for m in frames_b if m["type"] == "op-ack"]
        recv_a = [m["op"]["opId"] for m in frames_a if m["type"] == "op"]
        recv_b = [m["op"]["opId"] for m in frames_b if m["type"] == "op"]
        assert [m["opId"] for m in ack_a] == ["2@clientA"]
        assert [m["opId"] for m in ack_b] == ["1@clientB"]
        assert recv_a == ["1@clientB"]
        assert recv_b == ["2@clientA"]

    # third client joins late with an empty VV: full snapshot must converge
    with client.websocket_connect(f"/ws/{pid}") as wc:
        snap = _hello(wc, "clientC")
        ops = {o["opId"] for o in snap["ops"]}
        assert ops == {"1@clientA", "2@clientA", "1@clientB"}

    # server-computed state: B wins (lamport tie -> clientId), conflict flagged
    state = client.get(f"/api/plays/{pid}/state").json()
    view = state["view"]
    assert view["elements"]["e1"]["start"] == 20000
    assert any(c["kind"] == "edit" and c["elemId"] == "e1"
               for c in view["conflicts"])
    assert state["vv"] == {"clientA": 2, "clientB": 1}


def test_reconnect_with_cached_vv_gets_only_missing(client):
    r = client.post("/api/plays", json={"title": "重连测试"})
    pid = r.json()["playId"]
    with client.websocket_connect(f"/ws/{pid}") as wa:
        _hello(wa, "A2")
        add = _op(1, "A2", "add", "sound", "s1", 1, {"A2": 0},
                  {"name": "雷声", "start": 0, "duration": 2000})
        wa.send_json({"type": "op", "op": add})
        _recv_until(wa, "op-ack")

    with client.websocket_connect(f"/ws/{pid}") as wa2:
        # client already knows A2:1 -> no missing ops, but authoritative vv
        snap = _hello(wa2, "A2", vv={"A2": 1})
        assert snap["ops"] == []
        assert snap["vv"] == {"A2": 1}
        # explicitly request with older vv -> gets the missing op
        wa2.send_json({"type": "snapshot", "vv": {}})
        follow = _recv_until(wa2, "snapshot")
        assert [o["opId"] for o in follow["ops"]] == ["1@A2"]


def test_rejected_malformed_and_foreign_op(client):
    r = client.post("/api/plays", json={"title": "校验测试"})
    pid = r.json()["playId"]
    with client.websocket_connect(f"/ws/{pid}") as ws:
        _hello(ws, "X")
        bad = {"opId": "1@X", "type": "explode", "kind": "scene",
               "elemId": "e", "lamport": 1, "clientId": "X", "vv": {}}
        ws.send_json({"type": "op", "op": bad})
        rej = _recv_until(ws, "op-rejected")
        assert "type" in rej["error"]

        # cannot impersonate another client
        forged = _op(1, "Y", "add", "scene", "e", 1, {"Y": 0},
                     {"name": "伪造", "start": 0, "duration": 1})
        ws.send_json({"type": "op", "op": forged})
        rej2 = _recv_until(ws, "op-rejected")
        assert "clientId" in rej2["error"]


def test_import_export_roundtrip(client):
    r = client.post("/api/plays", json={"title": "导入源"})
    src = r.json()["playId"]
    with client.websocket_connect(f"/ws/{src}") as ws:
        _hello(ws, "IMP")
        add = _op(1, "IMP", "add", "scene", "sc1", 1, {"IMP": 0},
                  {"name": "终幕", "start": 0, "duration": 8000})
        ws.send_json({"type": "op", "op": add})
        _recv_until(ws, "op-ack")

    doc = client.get(f"/api/plays/{src}/export").json()
    assert doc["format"] == "rehearsal-timeline/v1"
    assert doc["timeUnit"] == "ms"

    # import as a brand new play
    created = client.post("/api/import", json=doc).json()
    assert created["imported"] == 1
    state = client.get(f"/api/plays/{created['playId']}/state").json()
    assert state["view"]["scenes"][0]["name"] == "终幕"

    # re-importing same document into that play skips duplicate opIds
    again = client.post(f"/api/plays/{created['playId']}/import", json=doc).json()
    assert again["imported"] == 0 and again["skipped"] == 1


def test_import_foreign_play_with_colliding_opids_rejected(client):
    """A different play's doc reusing opId 1@X must not be silently merged."""
    def make_play(name, elem):
        r = client.post("/api/plays", json={"title": name})
        pid = r.json()["playId"]
        with client.websocket_connect(f"/ws/{pid}") as ws:
            _hello(ws, "SAME")
            add = _op(1, "SAME", "add", "scene", elem, 1, {"SAME": 0},
                      {"name": elem, "start": 0, "duration": 1000})
            ws.send_json({"type": "op", "op": add})
            _recv_until(ws, "op-ack")
        return pid, client.get(f"/api/plays/{pid}/export").json()

    p1, d1 = make_play("剧目甲", "elem甲")
    p2, d2 = make_play("剧目乙", "elem乙")
    # same opId (1@SAME), different payload -> 409, nothing inserted
    r = client.post(f"/api/plays/{p1}/import", json=d2)
    assert r.status_code == 409
    state = client.get(f"/api/plays/{p1}/state").json()
    assert list(state["view"]["elements"]) == ["elem甲"]
    # re-importing its own export stays idempotent
    assert client.post(f"/api/plays/{p1}/import", json=d1).json() == {
        "imported": 0, "skipped": 1}


def test_health_and_static_ui(client):
    assert client.get("/api/health").json()["ok"] is True
    page = client.get("/")
    assert "剧场排练" in page.text
    assert client.get("/static/engine.js").status_code == 200

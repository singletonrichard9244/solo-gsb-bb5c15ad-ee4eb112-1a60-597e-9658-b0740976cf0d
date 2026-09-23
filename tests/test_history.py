"""Read-only historical comparison: causal cuts + visible-element diffs."""
from app.engine import (
    build_view,
    causal_cut,
    cut_version_vector,
    diff_views,
    fold,
    history_comparison,
)


def _op(seq, cid, typ, kind, elem, lamport, vv=None, payload=None, parent=None):
    op = {
        "opId": f"{seq}@{cid}",
        "type": typ,
        "kind": kind,
        "elemId": elem,
        "lamport": lamport,
        "clientId": cid,
        "vv": vv or {},
        "payload": payload or {},
    }
    if parent is not None:
        op["parent"] = parent
    return op


def _add(seq, cid, kind, elem, start, name=None, lamport=1, vv=None,
         duration=5000, parent=None):
    return _op(seq, cid, "add", kind, elem, lamport,
               vv if vv is not None else {cid: seq - 1},
               {"name": name or elem, "start": start, "duration": duration},
               parent)


def test_causal_cut_is_vv_only_not_lamport_or_arrival():
    """The cut folds the causal past only; lamport/arrival order are ignored.

    b (1@B, lamport 2) is concurrent with the anchor but has a *smaller*
    lamport than it: a naive ``lamport <= anchor`` cutoff would include it.
    d (1@C, lamport 10) was causally seen by the anchor despite its high
    lamport: it must stay in.
    """
    a = _add(1, "A", "sound", "snd", 0, name="snd", vv={"A": 0})
    b = _op(1, "B", "delete", "sound", "snd", 2, {"B": 0})
    d = _op(1, "C", "restore", "sound", "snd", 10, {"A": 1, "B": 0, "C": 0})
    anchor = _op(2, "A", "rename", "sound", "snd", 11,
                 {"A": 1, "C": 1}, {"name": "新名"})
    ops = [a, b, d, anchor]

    assert cut_version_vector(anchor) == {"A": 2, "C": 1}

    cut = causal_cut(ops, anchor)
    assert {o["opId"] for o in cut} == {"1@A", "1@C", "2@A"}

    # arrival order must not change the cut at all
    shuffled = [anchor, d, b, a]
    assert {o["opId"] for o in causal_cut(shuffled, anchor)} == {
        "1@A", "1@C", "2@A"}

    # inside the cut, B's concurrent delete never happened: C restored it
    then = build_view(fold(cut))
    assert then["elements"]["snd"]["deleted"] is False
    assert then["elements"]["snd"]["name"] == "新名"
    assert then["conflicts"] == []
    # full fold sees the concurrent delete/restore conflict
    full = build_view(fold(ops))
    assert any(c["kind"] == "delete-restore" for c in full["conflicts"])

    # anchor itself is part of its cut
    assert anchor["opId"] in {o["opId"] for o in causal_cut(ops, anchor)}


def test_diff_added_removed_changed_aligned_by_id():
    a = _add(1, "A", "scene", "sc1", 0, name="开场", duration=10000,
             vv={"A": 0})
    b = _add(1, "B", "action", "ac1", 1000, name="动作1", duration=3000,
             vv={"B": 0, "A": 1}, parent="sc1")
    c = _add(1, "C", "sound", "snd1", 2000, name="音效1", duration=2000,
             vv={"C": 0, "A": 1, "B": 1})
    anchor = _op(2, "A", "move", "scene", "sc1", 4,
                 {"A": 1, "B": 1, "C": 1}, {"start": 5000})

    # everything after the anchor: rename, edit, delete of a then-visible
    # sound, and a brand new sound
    later = [
        _op(3, "A", "rename", "scene", "sc1", 5,
            {"A": 2, "B": 1, "C": 1}, {"name": "序幕"}),
        _add(1, "D", "sound", "snd2", 9000, name="音效2", duration=1000,
             lamport=6, vv={"D": 0, "A": 2, "B": 1, "C": 1}),
        _op(2, "B", "move", "action", "ac1", 7,
            {"A": 2, "B": 1, "C": 1, "D": 1}, {"duration": 4000}),
        _op(2, "C", "delete", "sound", "snd1", 8,
            {"A": 2, "B": 1, "C": 1, "D": 1}),
    ]
    all_ops = [a, b, c, anchor] + later

    result = history_comparison(all_ops, anchor)
    assert result["anchor"]["opId"] == "2@A"
    assert result["cut"]["vv"] == {"A": 2, "B": 1, "C": 1}
    assert result["cut"]["opCount"] == 4
    diff = result["diff"]

    assert [e["id"] for e in diff["added"]] == ["snd2"]
    assert diff["added"][0]["now"]["name"] == "音效2"
    assert diff["added"][0]["then"] is None

    assert [e["id"] for e in diff["removed"]] == ["snd1"]
    assert diff["removed"][0]["reason"] == "deleted"
    assert diff["removed"][0]["now"] is None
    assert diff["removed"][0]["then"]["start"] == 2000

    changed = {e["id"]: e for e in diff["changed"]}
    assert list(changed) == ["sc1", "ac1"]           # scenes sort first
    assert changed["sc1"]["changes"] == [
        {"field": "name", "from": "开场", "to": "序幕"}]
    assert changed["ac1"]["changes"] == [
        {"field": "duration", "from": 3000, "to": 4000}]


def test_diff_parent_move_and_shadowing_by_deleted_scene():
    a = _add(1, "A", "scene", "sc1", 0, name="场次一", duration=20000,
             vv={"A": 0})
    a2 = _add(2, "A", "scene", "sc2", 20000, name="场次二", duration=10000,
              vv={"A": 1})
    ac1 = _add(1, "B", "action", "ac1", 1000, name="动作1", duration=3000,
               lamport=3, vv={"A": 2, "B": 0}, parent="sc1")
    ac2 = _add(1, "C", "action", "ac2", 2000, name="动作2", duration=3000,
               lamport=4, vv={"A": 2, "B": 1, "C": 0}, parent="sc1")
    anchor = _op(2, "B", "move", "action", "ac1", 5,
                 {"A": 2, "B": 1, "C": 1}, {"start": 1500})

    later = [
        _op(3, "B", "move", "action", "ac1", 6,
            {"A": 2, "B": 2, "C": 1}, {"parent": "sc2"}),
        _op(3, "A", "delete", "scene", "sc1", 7,
            {"A": 2, "B": 2, "C": 1}),
    ]
    all_ops = [a, a2, ac1, ac2, anchor] + later

    then_view = build_view(fold(causal_cut(all_ops, anchor)))
    now_view = build_view(fold(all_ops))
    diff = diff_views(then_view, now_view)

    assert diff["added"] == []
    # scene deleted + action shadowed by its deleted parent scene
    assert [e["id"] for e in diff["removed"]] == ["sc1", "ac2"]
    reasons = {e["id"]: e["reason"] for e in diff["removed"]}
    assert reasons["sc1"] == "deleted"
    assert reasons["ac2"] == "parent-deleted"
    # moved action is still visible: a plain field change, not a removal
    assert [e["id"] for e in diff["changed"]] == ["ac1"]
    assert diff["changed"][0]["changes"] == [
        {"field": "parent", "from": "sc1", "to": "sc2"}]

"""Deterministic CRDT-style merge engine for the rehearsal timeline.

Data model
----------
A play has elements of three kinds: scene > action (child of a scene) and
sound (top-level).  Every mutation is expressed as an immutable *operation*:

    {
      "opId":    "<clientSeq>@<clientId>",
      "type":    "add" | "move" | "rename" | "delete" | "restore",
      "kind":    "scene" | "action" | "sound",
      "elemId":  "element id",
      "lamport": int,                       # Lamport clock at emit time
      "clientId":"client id of the emitter",
      "vv":      {"<clientId>": seq, ...},  # version vector at emit time
      "parent":  parent element id | None,  # optional, e.g. add/move of action
      "payload": {field: value, ...}        # type dependent
    }

Merge semantics
---------------
* Ops are totally ordered by the deterministic key
  ``(lamport, clientId, clientSeq)``.
* ``a -> b`` (happened-before) when ``b.vv[a.clientId] >= a.clientSeq``.
* Operations on the same element are grouped; concurrent operations on the
  same *field* are either deterministically resolved (rename, start, duration,
  parent: highest lamport / total-order key wins) or both kept and flagged as
  a conflict (move vs delete, edit vs delete, restore vs delete).
* The fold is a pure function of the operation log: any client that has seen
  the same set of operations converges to the identical state.
"""
from __future__ import annotations

from typing import Any

TYPES = ("scene", "action", "sound")
SCENE_FIELDS = ("name", "start", "duration")
ACTION_FIELDS = ("name", "start", "duration", "parent")
SOUND_FIELDS = ("name", "start", "duration")
FIELDS_BY_KIND = {
    "scene": SCENE_FIELDS,
    "action": ACTION_FIELDS,
    "sound": SOUND_FIELDS,
}


def client_seq(op: dict) -> int:
    return int(str(op["opId"]).split("@", 1)[0])


def total_key(op: dict) -> tuple:
    return (int(op["lamport"]), str(op["clientId"]), client_seq(op))


def happens_before(a: dict, b: dict) -> bool:
    """True when ``b`` causally supersedes ``a``."""
    return int(b.get("vv", {}).get(a["clientId"], 0)) >= client_seq(a)


def _field_value(op: dict, field: str) -> Any:
    if field == "parent":
        if op["type"] == "add":
            return op.get("parent")
        return op.get("payload", {}).get("parent", op.get("parent"))
    return op.get("payload", {}).get(field)


def live_writers(ops: list[dict]) -> list[dict]:
    """Ops not causally superseded by another op from the same client.

    A client's later operation carries a VV covering its own earlier one, so
    stale writes drop out automatically.
    """
    out: list[dict] = []
    for op in ops:
        if not any(
            other is not op
            and other["clientId"] == op["clientId"]
            and happens_before(op, other)
            for other in ops
        ):
            out.append(op)
    return out


def fold(all_ops: list[dict]) -> dict:
    """Fold an operation log into elements + conflicts.

    Returns ``{"elements": {elemId: elem}, "conflicts": [conflict, ...]}``
    where each element is
    ``{id, kind, name, start, duration, parent, deleted, createKey}``.
    """
    # de-dup by opId, keep first occurrence (ops are immutable)
    by_id: dict[str, dict] = {}
    for op in all_ops:
        by_id.setdefault(op["opId"], op)
    ops = sorted(by_id.values(), key=total_key)

    groups: dict[str, list[dict]] = {}
    for op in ops:
        groups.setdefault(op["elemId"], []).append(op)

    elements: dict[str, dict] = {}
    conflicts: list[dict] = []

    for elem_id, gops in groups.items():
        adds = [o for o in gops if o["type"] == "add"]
        if not adds:
            continue  # never created (cannot happen in a valid log)
        add = adds[0]
        kind = add["kind"]
        elem: dict[str, dict] = {
            "id": elem_id,
            "kind": kind,
            "name": add.get("payload", {}).get("name", ""),
            "start": int(add.get("payload", {}).get("start", 0)),
            "duration": int(add.get("payload", {}).get("duration", 5000)),
            "parent": add.get("parent"),
            "deleted": False,
            "createKey": list(total_key(add)),
        }

        # ---- lifecycle: delete / restore (live ops in total order) --------
        lifecycle = [
            o
            for o in live_writers(gops)
            if o["type"] in ("delete", "restore")
        ]
        for o in lifecycle:
            elem["deleted"] = o["type"] == "delete"

        # ---- per-field last-writer resolution + edit conflicts ------------
        elem_conflicts: list[dict] = []
        for field in FIELDS_BY_KIND.get(kind, ()):
            writers = [
                o
                for o in gops
                if o["type"] in ("add", "move", "rename")
                and _field_value(o, field) is not None
            ]
            live = live_writers(writers)
            # distinct concurrent writers of the same field
            sources: dict[str, dict] = {}
            for o in live:
                cid = o["clientId"]
                if cid not in sources or total_key(o) > total_key(sources[cid]):
                    sources[cid] = o
            reps = list(sources.values())
            concurrent = all(
                not happens_before(reps[i], reps[j])
                for i in range(len(reps))
                for j in range(len(reps))
                if i != j
            )
            if len(reps) >= 2 and concurrent:
                ordered = sorted(reps, key=total_key)
                winner = ordered[-1]
                value = _field_value(winner, field)
                if field == "start":
                    value = int(value)
                elem[field] = value
                elem_conflicts.append(
                    {
                        "kind": "edit",
                        "elemId": elem_id,
                        "field": field,
                        "winnerOpId": winner["opId"],
                        "winnerClientId": winner["clientId"],
                        "winnerValue": value,
                        "candidates": [
                            {
                                "opId": o["opId"],
                                "clientId": o["clientId"],
                                "value": (
                                    int(_field_value(o, field))
                                    if field == "start"
                                    else _field_value(o, field)
                                ),
                            }
                            for o in ordered
                        ],
                    }
                )
            elif live:
                value = _field_value(sorted(live, key=total_key)[-1], field)
                if field in ("start", "duration"):
                    value = int(value)
                elem[field] = value

        # ---- delete/edit cross conflicts -----------------------------------
        alive_dels = [o for o in lifecycle if o["type"] == "delete"]
        if alive_dels:
            dop = sorted(alive_dels, key=total_key)[-1]
            edit_live = [
                o
                for o in live_writers(
                    [
                        o
                        for o in gops
                        if o["type"] in ("add", "move", "rename")
                    ]
                )
                if not happens_before(o, dop)
                and not happens_before(dop, o)
            ]
            # only edits strictly later than creation matter for marking
            later_edits = [o for o in edit_live if o["type"] != "add"]
            if later_edits:
                conflicts.append(
                    {
                        "kind": "delete",
                        "elemId": elem_id,
                        "deleteOpId": dop["opId"],
                        "deleteClientId": dop["clientId"],
                        "edits": [
                            {"opId": o["opId"], "clientId": o["clientId"],
                             "type": o["type"]}
                            for o in sorted(later_edits, key=total_key)
                        ],
                    }
                )

        # ---- delete/restore cross conflict ---------------------------------
        if len(lifecycle) >= 2:
            last_two = lifecycle[-2:]
            a, b = last_two[0], last_two[1]
            if not happens_before(a, b) and not happens_before(b, a):
                conflicts.append(
                    {
                        "kind": "delete-restore",
                        "elemId": elem_id,
                        "ops": [
                            {"opId": o["opId"],
                             "clientId": o["clientId"],
                             "type": o["type"]}
                            for o in (a, b)
                        ],
                        "resolvedAs": "deleted" if elem["deleted"] else "alive",
                    }
                )

        conflicts.extend(elem_conflicts)
        elements[elem_id] = elem

    return {"elements": elements, "conflicts": conflicts}


def _start_key(e: dict) -> tuple:
    return (e["start"], *e["createKey"])


def build_cue_sheet(view: dict, scene_id: str) -> dict | None:
    """Read-only cue sheet for one scene (pure function; emits no operations).

    Returns the visible actions and sounds that *start* inside the scene's
    half-open ``[start, start + duration)`` window, in the timeline's stable
    ``(start, createKey)`` order.  A cue exactly on the end boundary is
    excluded and therefore belongs to at most one scene.  Visibility reuses
    the folded view rules: deleted elements and actions whose parent scene is
    deleted/hidden never appear.  Each cue carries ``rel`` (start relative to
    the scene start), ``name`` and ``duration``.
    """
    scene = next((s for s in view["scenes"] if s["id"] == scene_id), None)
    if scene is None:
        return None
    visible: list[dict] = []
    for s in view["scenes"]:
        visible.extend(s.get("actions", []))
    visible.extend(view["sounds"])
    end = scene["start"] + scene["duration"]
    cues = [
        {
            "kind": c["kind"],
            "id": c["id"],
            "name": c["name"],
            "start": c["start"],
            "duration": c["duration"],
            "parent": c.get("parent"),
            "rel": c["start"] - scene["start"],
        }
        for c in sorted(visible, key=_start_key)
        if scene["start"] <= c["start"] < end
    ]
    return {
        "sceneId": scene["id"],
        "sceneName": scene["name"],
        "start": scene["start"],
        "end": end,
        "duration": scene["duration"],
        "cues": cues,
    }


def build_view(state: dict) -> dict:
    """Turn fold output into the ordered, orphan-filtered view the UI uses."""
    elements = state["elements"]
    scenes, sounds = [], []
    for elem in elements.values():
        if elem["deleted"]:
            continue
        if elem["kind"] == "scene":
            scenes.append(elem)
        elif elem["kind"] == "sound":
            sounds.append(elem)

    scenes.sort(key=_start_key)
    sounds.sort(key=_start_key)

    actions_by_scene: dict[str, list] = {}
    for elem in elements.values():
        if elem["deleted"] or elem["kind"] != "action":
            continue
        parent = elem.get("parent")
        if parent in elements and not elements[parent]["deleted"]:
            actions_by_scene.setdefault(parent, []).append(elem)
    for acts in actions_by_scene.values():
        acts.sort(key=_start_key)

    return {
        "scenes": [
            {
                **s,
                "actions": actions_by_scene.get(s["id"], []),
            }
            for s in scenes
        ],
        "sounds": sounds,
        "elements": elements,
        "conflicts": state["conflicts"],
    }


def version_vector(ops: list[dict]) -> dict[str, int]:
    vv: dict[str, int] = {}
    for op in ops:
        cid = op["clientId"]
        seq = client_seq(op)
        if seq > vv.get(cid, 0):
            vv[cid] = seq
    return vv


def next_lamport(ops: list[dict], seen_lamport: int = 0) -> int:
    return max([int(o["lamport"]) for o in ops] + [seen_lamport, 0]) + 1


def snapshot(all_ops: list[dict]) -> dict:
    state = fold(all_ops)
    return {
        "view": build_view(state),
        "vv": version_vector(all_ops),
        "lamport": max([int(o["lamport"]) for o in all_ops] + [0]),
        "opCount": len(all_ops),
    }

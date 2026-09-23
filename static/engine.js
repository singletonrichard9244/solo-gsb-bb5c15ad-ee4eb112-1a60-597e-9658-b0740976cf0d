// Deterministic merge engine — mirror of app/engine.py.
// Pure functions over the operation log; no dependencies.

export const FIELDS_BY_KIND = {
  scene: ['name', 'start', 'duration'],
  action: ['name', 'start', 'duration', 'parent'],
  sound: ['name', 'start', 'duration'],
};

export function clientSeq(op) {
  return parseInt(String(op.opId).split('@', 1)[0], 10);
}

export function totalKey(op) {
  return [parseInt(op.lamport, 10), String(op.clientId), clientSeq(op)];
}

// compare total keys: -1 | 0 | 1
export function cmpKey(a, b) {
  const ka = totalKey(a), kb = totalKey(b);
  for (let i = 0; i < 3; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

// b causally supersedes a when b's VV covers a's per-client seq
export function happensBefore(a, b) {
  return parseInt((b.vv || {})[a.clientId] || 0, 10) >= clientSeq(a);
}

function fieldValue(op, field) {
  if (field === 'parent') {
    if (op.type === 'add') return op.parent ?? null;
    return op.payload?.parent ?? null;
  }
  return op.payload?.[field] ?? null;
}

function liveWriters(ops) {
  return ops.filter(
    (op) =>
      !ops.some(
        (other) =>
          other !== op &&
          other.clientId === op.clientId &&
          happensBefore(op, other),
      ),
  );
}

export function fold(allOps) {
  // de-dup by opId (ops are immutable; first occurrence wins)
  const byId = new Map();
  for (const op of allOps) if (!byId.has(op.opId)) byId.set(op.opId, op);
  const ops = [...byId.values()].sort((a, b) => cmpKey(a, b));

  const groups = new Map();
  for (const op of ops) {
    if (!groups.has(op.elemId)) groups.set(op.elemId, []);
    groups.get(op.elemId).push(op);
  }

  const elements = new Map();
  const conflicts = [];

  for (const [elemId, gops] of groups) {
    const adds = gops.filter((o) => o.type === 'add');
    if (!adds.length) continue; // never created
    const add = adds[0];
    const kind = add.kind;
    const elem = {
      id: elemId,
      kind,
      name: add.payload?.name ?? '',
      start: parseInt(add.payload?.start ?? 0, 10),
      duration: parseInt(add.payload?.duration ?? 5000, 10),
      parent: add.parent ?? null,
      deleted: false,
      createKey: totalKey(add),
    };

    // ---- lifecycle: delete / restore (live ops in total order) ----
    const lifecycle = liveWriters(gops).filter((o) =>
      ['delete', 'restore'].includes(o.type),
    );
    for (const o of lifecycle) elem.deleted = o.type === 'delete';

    // ---- per-field last-writer resolution + edit conflicts ----
    const elemConflicts = [];
    for (const field of FIELDS_BY_KIND[kind] || []) {
      const writers = gops.filter(
        (o) =>
          ['add', 'move', 'rename'].includes(o.type) &&
          fieldValue(o, field) !== null,
      );
      const live = liveWriters(writers);
      // newest op per client only
      const sources = new Map();
      for (const o of live) {
        const prev = sources.get(o.clientId);
        if (!prev || cmpKey(o, prev) > 0) sources.set(o.clientId, o);
      }
      const reps = [...sources.values()];
      const concurrent = reps.every((ri, i) =>
        reps.every((rj, j) => i === j || !happensBefore(ri, rj)),
      );
      if (reps.length >= 2 && concurrent) {
        const ordered = [...reps].sort((a, b) => cmpKey(a, b));
        const winner = ordered[ordered.length - 1];
        let value = fieldValue(winner, field);
        if (field === 'start') value = parseInt(value, 10);
        elem[field] = value;
        elemConflicts.push({
          kind: 'edit',
          elemId,
          field,
          winnerOpId: winner.opId,
          winnerClientId: winner.clientId,
          winnerValue: value,
          candidates: ordered.map((o) => {
            let v = fieldValue(o, field);
            if (field === 'start') v = parseInt(v, 10);
            return { opId: o.opId, clientId: o.clientId, value: v };
          }),
        });
      } else if (live.length) {
        const newest = [...live].sort((a, b) => cmpKey(a, b)).pop();
        let value = fieldValue(newest, field);
        if (field === 'start' || field === 'duration') value = parseInt(value, 10);
        elem[field] = value;
      }
    }

    // ---- delete/edit cross conflicts ----
    const aliveDels = lifecycle.filter((o) => o.type === 'delete');
    if (aliveDels.length) {
      const dop = [...aliveDels].sort((a, b) => cmpKey(a, b)).pop();
      const editLive = liveWriters(
        gops.filter((o) => ['add', 'move', 'rename'].includes(o.type)),
      ).filter((o) => !happensBefore(o, dop) && !happensBefore(dop, o));
      const laterEdits = editLive.filter((o) => o.type !== 'add');
      if (laterEdits.length) {
        conflicts.push({
          kind: 'delete',
          elemId,
          deleteOpId: dop.opId,
          deleteClientId: dop.clientId,
          edits: [...laterEdits]
            .sort((a, b) => cmpKey(a, b))
            .map((o) => ({ opId: o.opId, clientId: o.clientId, type: o.type })),
        });
      }
    }

    // ---- delete/restore cross conflict ----
    if (lifecycle.length >= 2) {
      const [a, b] = lifecycle.slice(-2);
      if (!happensBefore(a, b) && !happensBefore(b, a)) {
        conflicts.push({
          kind: 'delete-restore',
          elemId,
          ops: [a, b].map((o) => ({
            opId: o.opId,
            clientId: o.clientId,
            type: o.type,
          })),
          resolvedAs: elem.deleted ? 'deleted' : 'alive',
        });
      }
    }

    conflicts.push(...elemConflicts);
    elements.set(elemId, elem);
  }

  return { elements, conflicts };
}

// timeline-stable element order: (start, createKey), matching buildView
export function cmpStartKey(a, b) {
  if (a.start !== b.start) return a.start - b.start;
  for (let i = 0; i < 3; i++) {
    if (a.createKey[i] < b.createKey[i]) return -1;
    if (a.createKey[i] > b.createKey[i]) return 1;
  }
  return 0;
}

// Read-only scene cue sheet: visible actions/sounds that START inside the
// scene's half-open [start, start+duration) window — a cue exactly on the end
// boundary is excluded here and belongs to the next scene. Visibility reuses
// the folded view: deleted elements and actions whose parent scene is deleted
// are already absent from scene.actions / sounds. Emits no operations.
export function buildCueSheet(view, sceneId) {
  const scene = (view.scenes || []).find((s) => s.id === sceneId);
  if (!scene) return null;
  const visible = [];
  for (const s of view.scenes) for (const a of s.actions || []) visible.push(a);
  for (const snd of view.sounds || []) visible.push(snd);
  const end = scene.start + scene.duration;
  const cues = visible
    .filter((c) => c.start >= scene.start && c.start < end)
    .sort(cmpStartKey)
    .map((c) => ({
      kind: c.kind,
      id: c.id,
      name: c.name,
      start: c.start,
      duration: c.duration,
      parent: c.parent ?? null,
      rel: c.start - scene.start,
    }));
  return {
    sceneId: scene.id,
    sceneName: scene.name,
    start: scene.start,
    end,
    duration: scene.duration,
    cues,
  };
}

export function buildView(state) {
  const { elements, conflicts } = state;
  const scenes = [];
  const sounds = [];
  for (const elem of elements.values()) {
    if (elem.deleted) continue;
    if (elem.kind === 'scene') scenes.push(elem);
    else if (elem.kind === 'sound') sounds.push(elem);
  }
  scenes.sort(cmpStartKey);
  sounds.sort(cmpStartKey);

  const actionsByScene = new Map();
  for (const elem of elements.values()) {
    if (elem.deleted || elem.kind !== 'action') continue;
    const parent = elements.get(elem.parent);
    if (parent && !parent.deleted) {
      if (!actionsByScene.has(elem.parent)) actionsByScene.set(elem.parent, []);
      actionsByScene.get(elem.parent).push(elem);
    }
  }
  for (const acts of actionsByScene.values()) acts.sort(cmpStartKey);

  return {
    scenes: scenes.map((s) => ({
      ...s,
      actions: actionsByScene.get(s.id) || [],
    })),
    sounds,
    elements: Object.fromEntries(elements),
    conflicts,
  };
}

export function versionVector(ops) {
  const vv = {};
  for (const op of ops) {
    const seq = clientSeq(op);
    if (seq > (vv[op.clientId] || 0)) vv[op.clientId] = seq;
  }
  return vv;
}

export function snapshot(allOps) {
  const state = fold(allOps);
  return {
    view: buildView(state),
    vv: versionVector(allOps),
    lamport: allOps.reduce((m, o) => Math.max(m, parseInt(o.lamport, 10)), 0),
    opCount: allOps.length,
  };
}

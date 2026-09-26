// Quick equivalence check of static/engine.js against the Python scenarios.
// Run: node tests/engine.node.mjs
import assert from 'node:assert';
import { fold, buildView, buildCueSheet, versionVector, clientSeq, snapshot, totalKey,
  causalCutVV, opsInCut, viewAtCut, diffViews } from '../static/engine.js';

const op = (seq, cid, type, kind, elemId, lamport, vv = {}, payload = {}, parent) => {
  const o = { opId: `${seq}@${cid}`, type, kind, elemId, lamport, clientId: cid, vv, payload };
  if (parent !== undefined) o.parent = parent;
  return o;
};
const add = (seq, cid, kind, elem, start, name, lamport = 1, vv, parent) =>
  op(seq, cid, 'add', kind, elem, lamport, vv || { [cid]: seq - 1 },
    { name: name || elem, start, duration: 5000 }, parent);

// 1. concurrent move -> deterministic winner, conflict flagged
{
  const a = add(1, 'A', 'scene', 's1', 0);
  const m1 = op(2, 'A', 'move', 'scene', 's1', 2, { A: 1 }, { start: 10000 });
  const m2 = op(1, 'B', 'move', 'scene', 's1', 2, { B: 0 }, { start: 20000 });
  const v1 = buildView(fold([a, m1, m2]));
  const v2 = buildView(fold([m2, a, m1]));
  assert.equal(v1.scenes[0].start, 20000);
  assert.equal(JSON.stringify(v1.scenes), JSON.stringify(v2.scenes));
  assert.equal(v1.conflicts[0].winnerClientId, 'B');
}

// 2. higher lamport wins
{
  const a = add(1, 'A', 'scene', 's1', 0);
  const m1 = op(2, 'B', 'move', 'scene', 's1', 5, { A: 1, B: 1 }, { start: 30000 });
  const m2 = op(2, 'A', 'move', 'scene', 's1', 4, { A: 1 }, { start: 10000 });
  assert.equal(buildView(fold([a, m1, m2])).scenes[0].start, 30000);
}

// 3. causal move -> no conflict
{
  const a = add(1, 'A', 'scene', 's1', 0);
  const m1 = op(2, 'A', 'move', 'scene', 's1', 2, { A: 1 }, { start: 10000 });
  const m2 = op(1, 'B', 'move', 'scene', 's1', 3, { A: 2, B: 0 }, { start: 20000 });
  const v = buildView(fold([a, m1, m2]));
  assert.equal(v.scenes[0].start, 20000);
  assert.equal(v.conflicts.length, 0);
}

// 4. delete vs concurrent edit
{
  const a = add(1, 'A', 'scene', 's1', 0);
  const m = op(2, 'A', 'move', 'scene', 's1', 2, { A: 1 }, { start: 9000 });
  const d = op(1, 'B', 'delete', 'scene', 's1', 2, { B: 0 });
  const v = buildView(fold([a, m, d]));
  assert.equal(v.elements.s1.deleted, true);
  assert.equal(v.conflicts[0].kind, 'delete');
}

// 5. causal restore after delete -> no conflict
{
  const a = add(1, 'A', 'scene', 's1', 0);
  const d = op(2, 'A', 'delete', 'scene', 's1', 2, { A: 1 });
  const r = op(1, 'B', 'restore', 'scene', 's1', 3, { A: 2, B: 0 });
  const v = buildView(fold([a, d, r]));
  assert.equal(v.elements.s1.deleted, false);
  assert.equal(v.conflicts.length, 0);
}

// 6. action under scene + ordering
{
  const sa = add(1, 'A', 'scene', 'scA', 20000);
  const sb = add(2, 'A', 'scene', 'scB', 0, undefined, undefined, { A: 1 });
  const ac = add(1, 'B', 'action', 'ac1', 1000, undefined, 3, { A: 2, B: 0 }, 'scB');
  const v = buildView(fold([sa, sb, ac]));
  assert.deepEqual(v.scenes.map((s) => s.id), ['scB', 'scA']);
  assert.deepEqual(v.scenes[0].actions.map((x) => x.id), ['ac1']);
}

// 7. VV incremental
{
  const ops = [
    add(1, 'A', 'scene', 's1', 0),
    op(2, 'A', 'move', 'scene', 's1', 2, { A: 1 }, { start: 5000 }),
    add(1, 'B', 'sound', 'sd1', 1000, undefined, 3, { A: 2, B: 0 }),
  ];
  assert.deepEqual(versionVector(ops), { A: 2, B: 1 });
  const have = { A: 2, B: 0 };
  const missing = ops.filter((o) => (have[o.clientId] || 0) < clientSeq(o));
  assert.deepEqual(missing.map((o) => o.opId), ['1@B']);
  assert.deepEqual(snapshot(ops).vv, { A: 2, B: 1 });
}

// 8. three-way convergence under shuffle
{
  const a = add(1, 'A', 'scene', 's1', 0);
  const am = op(2, 'A', 'move', 'scene', 's1', 2, { A: 1 }, { start: 7000 });
  const bm = op(1, 'B', 'move', 'scene', 's1', 3, { A: 1, B: 0 }, { start: 12000 });
  const cd = op(1, 'C', 'delete', 'scene', 's1', 4, { A: 1, C: 0 });
  const canon = JSON.stringify(buildView(fold([a, am, bm, cd])));
  for (const order of [[cd, bm, a, am], [a, cd, am, bm], [bm, am, cd, a]]) {
    assert.equal(JSON.stringify(buildView(fold(order))), canon);
  }
}

// 9. rename conflict on name field
{
  const a = add(1, 'A', 'scene', 's1', 0, '原名称');
  const r1 = op(2, 'A', 'rename', 'scene', 's1', 2, { A: 1 }, { name: 'A名' });
  const r2 = op(1, 'B', 'rename', 'scene', 's1', 2, { B: 0 }, { name: 'B名' });
  const v = buildView(fold([a, r1, r2]));
  assert.equal(v.scenes[0].name, 'B名');
  assert.equal(v.conflicts[0].field, 'name');
  assert.deepEqual(v.conflicts[0].candidates.map((c) => c.value), ['A名', 'B名']);
}

// 10. read-only scene cue sheet: half-open window, visibility, stable order
{
  const ops = [
    op(1, 'A', 'add', 'scene', 'scA', 1, { A: 0 },
      { name: '场次A', start: 1000, duration: 10000 }),
    op(1, 'B', 'add', 'scene', 'scB', 1, { B: 0 },
      { name: '场次B', start: 11000, duration: 10000 }),
    op(1, 'K', 'add', 'scene', 'scC', 1, { K: 0 },
      { name: '场次C', start: 50000, duration: 5000 }),
    op(2, 'K', 'delete', 'scene', 'scC', 2, { K: 1 }),
    add(1, 'C', 'action', 'aInA', 2000, undefined, 1, undefined, 'scA'),
    add(1, 'F', 'action', 'aOutside', 12000, undefined, 1, undefined, 'scA'),
    add(1, 'G', 'action', 'aOrphan', 3000, undefined, 1, undefined, 'scGhost'),
    add(1, 'D', 'sound', 'sndInA', 5000),
    add(1, 'E', 'sound', 'sndBoundary', 11000),
    add(1, 'H', 'sound', 'sndDeleted', 4000),
    op(2, 'H', 'delete', 'sound', 'sndDeleted', 2, { H: 1 }),
    op(1, 'I', 'add', 'action', 'actTie', 3, { I: 0 },
      { name: 'actTie', start: 5000, duration: 5000 }, 'scA'),
    op(1, 'J', 'add', 'sound', 'sndTie', 5, { J: 0 },
      { name: 'sndTie', start: 5000, duration: 5000 }),
  ];
  const view = buildView(fold(ops));
  const a = buildCueSheet(view, 'scA');
  assert.deepEqual(a.cues.map((c) => c.id), ['aInA', 'sndInA', 'actTie', 'sndTie']);
  assert.equal(a.start, 1000);
  assert.equal(a.end, 11000);
  assert.ok(a.cues.every((c) => c.start >= 1000 && c.start < 11000));
  assert.equal(a.cues[0].rel, 1000);
  const b = buildCueSheet(view, 'scB');
  assert.deepEqual(b.cues.map((c) => c.id), ['sndBoundary', 'aOutside']);
  assert.equal(b.cues[0].rel, 0);
  assert.equal(buildCueSheet(view, 'scC'), null);
  assert.equal(buildCueSheet(view, 'nope'), null);
  const shown = new Set([...a.cues, ...b.cues].map((c) => c.id));
  assert.ok(!shown.has('sndDeleted') && !shown.has('aOrphan'));
}

// 11. read-only history compare: causal cut membership + view diff
{
  const a1 = add(1, 'A', 'scene', 's1', 0, '开场');
  const b1 = add(1, 'B', 'sound', 'sd1', 2000, '雷声', 1, { B: 0 });
  const e1 = add(1, 'E', 'scene', 'sDel', 40000, '将被删', 2, { E: 0 });
  const e2 = add(2, 'E', 'action', 'actD', 41000, '旧动作', 3, { E: 1 }, 'sDel');
  const anchor = add(2, 'A', 'action', 'act1', 1000, '动作一', 4,
    { A: 1, B: 1, E: 2 }, 's1');
  const a3 = op(3, 'A', 'rename', 'scene', 's1', 5, { A: 2 }, { name: '开幕' });
  const a4 = op(4, 'A', 'move', 'action', 'act1', 6, { A: 3 }, { start: 1500 });
  const c1 = add(1, 'C', 'scene', 's2', 20000, '第二幕', 7, { A: 4, C: 0 });
  const a5 = op(5, 'A', 'move', 'action', 'act1', 8, { A: 4, C: 1 }, { parent: 's2' });
  const b2 = op(2, 'B', 'delete', 'sound', 'sd1', 9, { A: 2, B: 1 });
  const e3 = op(3, 'E', 'delete', 'scene', 'sDel', 10, { E: 2 });
  const d1 = add(1, 'D', 'scene', 'sGone', 50000, '废弃场', 11, { D: 0 });
  const d2 = add(2, 'D', 'action', 'actHidden', 51000, '被遮蔽', 12, { D: 1 }, 'sGone');
  const d3 = op(3, 'D', 'delete', 'scene', 'sGone', 13, { D: 2 });
  const log = [a1, b1, e1, e2, anchor, a3, a4, c1, a5, b2, e3, d1, d2, d3];

  const cut = causalCutVV(anchor);
  assert.deepEqual(cut, { A: 2, B: 1, E: 2 });

  const hist = viewAtCut(log, cut);
  assert.deepEqual(hist.scenes.map((s) => s.id), ['s1', 'sDel']);
  assert.deepEqual(hist.sounds.map((s) => s.id), ['sd1']);

  const now = buildView(fold(log));
  const diff = diffViews(hist, now);
  assert.deepEqual(diff.added.map((e) => e.id), ['s2']);
  assert.deepEqual(new Set(diff.removed.map((e) => e.id)),
    new Set(['sd1', 'sDel', 'actD']));
  const flat = new Set([...diff.added, ...diff.removed, ...diff.changed]
    .map((e) => e.id));
  assert.ok(!flat.has('sGone') && !flat.has('actHidden'));
  const changed = Object.fromEntries(diff.changed.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(changed).sort(), ['act1', 's1']);
  assert.deepEqual(changed.s1.fields, [{ field: 'name', from: '开场', to: '开幕' }]);
  assert.deepEqual(changed.act1.fields, [
    { field: 'start', from: 1000, to: 1500 },
    { field: 'parent', from: 's1', to: 's2' },
  ]);
}

// 12. cut membership ignores lamport values and arrival order
{
  const o1 = add(1, 'A', 'scene', 's1', 0);
  const o2 = op(2, 'A', 'move', 'scene', 's1', 2, { A: 1 }, { start: 1000 });
  const anchor = op(3, 'A', 'move', 'scene', 's1', 3, { A: 2, B: 2 }, { start: 2000 });
  const hi = op(2, 'B', 'move', 'scene', 's1', 99, { A: 2, B: 1 }, { start: 9000 });
  const lo = op(3, 'B', 'move', 'scene', 's1', 1, { B: 2 }, { start: 7000 });
  const late = op(4, 'A', 'move', 'scene', 's1', 4, { A: 3 }, { start: 500 });

  const cut = causalCutVV(anchor);
  assert.deepEqual(cut, { A: 3, B: 2 });
  const log = [o1, o2, anchor, hi, lo, late];
  const inside = new Set(opsInCut(log, cut).map((o) => o.opId));
  assert.deepEqual([...inside].sort(), ['1@A', '2@A', '2@B', '3@A']);
  const insideRev = new Set(opsInCut([...log].reverse(), cut).map((o) => o.opId));
  assert.deepEqual([...insideRev].sort(), [...inside].sort());
  const hist = viewAtCut(log, cut);
  // 2@B (lamport 99) wins inside the cut; 3@B (lamport 1) and 4@A stay out
  assert.equal(hist.scenes[0].start, 9000);
  assert.equal(hist.conflicts.length, 0);
}

console.log('JS engine: all 12 scenario groups passed');

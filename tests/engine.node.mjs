// Quick equivalence check of static/engine.js against the Python scenarios.
// Run: node tests/engine.node.mjs
import assert from 'node:assert';
import { fold, buildView, buildCueSheet, versionVector, clientSeq, snapshot, totalKey } from '../static/engine.js';

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

console.log('JS engine: all 10 scenario groups passed');

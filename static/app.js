// ============================================================================
// 剧场排练时序编排 — 前端客户端
// 操作日志 + Lamport 时钟；断线写本地队列，重连按版本向量合并
// ============================================================================
import { fold, buildView, buildCueSheet, versionVector, clientSeq, totalKey, cmpKey } from './engine.js';

const SNAP_MS = 250;                       // 拖拽吸附粒度
const PX_PER_MS = 0.024;                   // 24px / 秒
const KIND_LABEL = { scene: '场次', action: '动作', sound: '音效' };

// ---------------------------------------------------------------- storage ----
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  del(k) { localStorage.removeItem(k); },
};
const opsKey = (pid) => `rt:play:${pid}:ops`;
const queueKey = (pid) => `rt:play:${pid}:queue`;

// ------------------------------------------------------------- tiny utils ----
const $ = (sel) => document.querySelector(sel);
const shortId = (id) => String(id || '').slice(0, 4);
const fmtTime = (ms) => {
  ms = Math.max(0, Math.round(ms));
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
};
function parseTime(txt) {
  txt = String(txt).trim();
  if (/^\d+$/.test(txt)) return parseInt(txt, 10);          // 纯毫秒
  const m = txt.match(/^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (m) {
    const frac = (m[3] || '').padEnd(3, '0');
    return (+m[1]) * 60000 + (+m[2]) * 1000 + parseInt(frac, 10);
  }
  return null;
}
function hashColor(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 72% 58%)`;
}
function uid(prefix) {
  return prefix + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    : Math.random().toString(36).slice(2, 12));
}
let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ----------------------------------------------------------------- state ----
const state = {
  profile: LS.get('rt:profile', null),          // {clientId,name,color}
  playId: null,
  title: '',
  ops: new Map(),          // opId -> op（全部已知操作，含自己未确认的）
  queue: [],               // 本地未确认操作（断线缓冲）
  view: null,
  lamport: 0,
  serverVV: {},
  members: new Map(),      // clientId -> {name,color}
  ws: null,
  connected: false,
  backoff: 500,
  retryTimer: null,
  closing: false,
  selectedId: null,
  cueSceneId: null,        // 只读提示单当前场次（本地视图状态，不产生操作）
  dragging: null,          // {id, origStart, origX, width}
  suppressDetail: false,
};

function ensureProfile() {
  if (!state.profile) {
    const clientId = uid('c_');
    state.profile = { clientId, name: '', color: hashColor(clientId) };
    LS.set('rt:profile', state.profile);
  }
}
function nextOwnSeq() {
  const cid = state.profile.clientId;
  let max = state.serverVV[cid] || 0;
  for (const op of state.ops.values())
    if (op.clientId === cid) max = Math.max(max, clientSeq(op));
  return max + 1;
}

// ------------------------------------------------------------- operations ----
function recompute() {
  const all = [...state.ops.values()];
  state.view = buildView(fold(all));
  state.lamport = all.reduce((m, o) => Math.max(m, parseInt(o.lamport, 10)), 0);
}
function persistOps() { LS.set(opsKey(state.playId), [...state.ops.values()]); }
function persistQueue() { LS.set(queueKey(state.playId), state.queue); }

function emitOp(type, kind, elemId, payload = {}, parent) {
  const cid = state.profile.clientId;
  const seq = nextOwnSeq();
  state.lamport += 1;
  const op = {
    opId: `${seq}@${cid}`,
    type, kind, elemId,
    lamport: state.lamport,
    clientId: cid,
    vv: versionVector([...state.ops.values()]),
    payload,
  };
  if (parent !== undefined) op.parent = parent;
  state.ops.set(op.opId, op);
  state.queue.push(op);
  persistOps(); persistQueue();
  if (state.connected) state.ws.send(JSON.stringify({ type: 'op', op }));
  recompute(); render();
  return op;
}

function addElement(kind, parent) {  const v = state.view;
  const counters = { scene: 0, action: 0, sound: 0 };
  for (const e of Object.values(v.elements)) counters[e.kind]++;
  let start = 0, duration = kind === 'sound' ? 3000 : kind === 'action' ? 3000 : 10000;
  let name;
  if (kind === 'scene') {
    start = v.scenes.reduce((m, s) => Math.max(m, s.start + s.duration), 0);
    name = `场次 ${counters.scene + 1}`;
  } else if (kind === 'sound') {
    start = v.sounds.reduce((m, s) => Math.max(m, s.start + s.duration), 0);
    name = `音效 ${counters.sound + 1}`;
  } else {
    const scene = v.elements[parent];
    start = scene ? scene.start : 0;
    name = `动作 ${counters.action + 1}`;
  }
  const id = uid('e_');
  emitOp('add', kind, id, { name, start, duration: duration },
    kind === 'action' ? parent : undefined);
  state.selectedId = id;
  switchTab('detail');
  return id;
}
const removeElement = (id) => emitOp('delete', state.view.elements[id].kind, id);
const restoreElement = (id) => emitOp('restore', state.view.elements[id].kind, id);

function moveField(id, field, value) {
  const elem = state.view.elements[id];
  const payload = { [field]: value };
  emitOp('move', elem.kind, id, payload);
}
function renameElement(id, name) {
  const elem = state.view.elements[id];
  emitOp('rename', elem.kind, id, { name });
}

// ------------------------------------------------------------ websocket ----
function connect() {
  if (!state.playId) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN
      || state.ws.readyState === WebSocket.CONNECTING)) return;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws/${state.playId}`);
  state.ws = ws;
  state.closing = false;
  setConn('connecting');

  ws.onopen = () => {
    state.connected = true;
    state.backoff = 500;
    setConn('online');
    const vv = versionVector([...state.ops.values()]);
    ws.send(JSON.stringify({
      type: 'hello',
      clientId: state.profile.clientId,
      name: state.profile.name || '匿名成员',
      color: state.profile.color,
      vv,
    }));
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'snapshot': {
        for (const op of msg.ops || []) state.ops.set(op.opId, op);
        state.serverVV = msg.vv || {};
        // 版本向量覆盖到的本地缓冲操作说明已在服务端落盘
        state.queue = state.queue.filter((op) =>
          (state.serverVV[op.clientId] || 0) < clientSeq(op));
        persistOps(); persistQueue();
        flushQueue();
        recompute(); render();
        break;
      }
      case 'op': {
        const op = msg.op;
        if (!state.ops.has(op.opId)) {
          state.ops.set(op.opId, op);
          state.lamport = Math.max(state.lamport, parseInt(op.lamport, 10));
          persistOps();
          recompute(); render();
        }
        break;
      }
      case 'op-ack':
        state.queue = state.queue.filter((op) => op.opId !== msg.opId);
        persistQueue(); render();
        break;
      case 'op-rejected':
        toast(`操作被服务端拒绝：${msg.error}`, true);
        break;
      case 'presence':
        state.members = new Map((msg.members || []).map((m) => [m.clientId, m]));
        renderMembers(); renderConflicts();
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        break;
    }
  };

  ws.onclose = () => {
    state.connected = false;
    if (state.ws === ws) state.ws = null;
    setConn('offline');
    if (!state.closing) scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function flushQueue() {
  if (!state.connected) return;
  for (const op of [...state.queue].sort((a, b) => cmpKey(a, b))) {
    state.ws.send(JSON.stringify({ type: 'op', op }));
  }
}

function scheduleReconnect() {
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => {
    connect();
    state.backoff = Math.min(state.backoff * 1.6, 5000);
  }, state.backoff);
}

function setConn(status) {
  const dot = $('#conn-dot'), txt = $('#conn-text');
  dot.className = 'dot ' + (status === 'online' ? 'online'
    : status === 'offline' ? 'offline' : 'connecting');
  if (status === 'online') txt.textContent = '已同步';
  else if (status === 'offline')
    txt.textContent = state.queue.length ? `离线 · 缓冲 ${state.queue.length} 条操作` : '离线 · 重连中…';
  else txt.textContent = '连接中…';
}

// -------------------------------------------------------------- members ----
function renderMembers() {
  const box = $('#members');
  box.innerHTML = '';
  for (const m of state.members.values()) {
    const chip = document.createElement('span');
    chip.className = 'member-chip';
    chip.title = m.name;
    chip.innerHTML = `<i style="background:${m.color}"></i>${m.name}`;
    box.appendChild(chip);
  }
}
function who(cid) {
  const m = state.members.get(cid);
  return { name: m ? m.name : `用户 ${shortId(cid)}`, color: m ? m.color : hashColor(cid) };
}

// ================================================================ render ====
function timelineWidth() {
  let end = 60000;
  for (const e of Object.values(state.view.elements))
    if (!e.deleted) end = Math.max(end, e.start + e.duration + 15000);
  return Math.max(end * PX_PER_MS, 600);
}

function tickSteps() {
  const cands = [250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000];
  return cands.find((s) => s * PX_PER_MS >= 80) || 300000;
}

function renderRuler(width, step) {
  const track = $('#ruler-track');
  track.style.width = width + 'px';
  track.innerHTML = '';
  for (let t = 0; t * PX_PER_MS < width; t += step) {
    const tick = document.createElement('div');
    tick.className = 'tick major';
    tick.style.left = t * PX_PER_MS + 'px';
    tick.textContent = fmtTime(t);
    track.appendChild(tick);
  }
}

function gridCells(canvas, width, step) {
  for (let t = 0; t * PX_PER_MS < width; t += step) {
    if (t === 0) continue;
    const cell = document.createElement('div');
    cell.className = 'grid-cell';
    cell.style.left = t * PX_PER_MS + 'px';
    canvas.appendChild(cell);
  }
}

function conflictIds() {
  const set = new Set();
  for (const c of state.view.conflicts) set.add(c.elemId);
  return set;
}

function makeBlock(elem) {
  const b = document.createElement('div');
  b.className = `block ${elem.kind}-block${elem.deleted ? ' deleted' : ''}`;
  b.dataset.id = elem.id;
  if (elem.id === state.selectedId) b.classList.add('selected');
  const left = state.dragging && state.dragging.id === elem.id
    ? state.dragging.leftPx : elem.start * PX_PER_MS;
  b.style.left = left + 'px';
  b.style.width = Math.max(elem.duration * PX_PER_MS, 26) + 'px';
  b.title = `${elem.name}（${fmtTime(elem.start)} · ${elem.duration}ms）`;

  const name = document.createElement('span');
  name.className = 'block-name';
  name.textContent = elem.name;
  b.appendChild(name);

  const x = document.createElement('span');
  x.className = 'block-x';
  x.textContent = '×';
  x.title = '删除';
  x.addEventListener('pointerdown', (e) => e.stopPropagation());
  x.addEventListener('click', (e) => { e.stopPropagation(); removeElement(elem.id); });
  b.appendChild(x);

  b.addEventListener('pointerdown', onDragStart);
  b.addEventListener('click', () => selectElement(elem.id));
  return b;
}

function render() {
  if (!state.view) return;
  setConn(state.connected ? 'online' : 'offline');
  const v = state.view;
  const width = timelineWidth();
  const step = tickSteps();
  renderRuler(width, step);

  const lanes = $('#lanes');
  lanes.innerHTML = '';
  const cSet = conflictIds();

  const newRow = (labelText, subText, laneClass, canvasClass, onAdd) => {
    const row = document.createElement('div');
    row.className = `lane-row ${laneClass}`;
    const label = document.createElement('div');
    label.className = 'lane-label';
    label.innerHTML = `<span class="lane-title"></span><span class="lane-sub"></span>`;
    label.querySelector('.lane-title').textContent = labelText;
    label.querySelector('.lane-sub').textContent = subText || '';
    const canvas = document.createElement('div');
    canvas.className = 'lane-canvas ' + canvasClass;
    canvas.style.width = width + 'px';
    gridCells(canvas, width, step);
    if (onAdd) {
      const add = document.createElement('button');
      add.className = 'add-mini';
      add.textContent = '＋';
      add.addEventListener('click', onAdd);
      canvas.appendChild(add);
    }
    row.append(label, canvas);
    lanes.appendChild(row);
    return canvas;
  };

  for (const scene of v.scenes) {
    const sCanvas = newRow(scene.name,
      `${fmtTime(scene.start)} – ${fmtTime(scene.start + scene.duration)}`,
      'scene-lane', 'scene-canvas');
    const sb = makeBlock(scene);
    if (cSet.has(scene.id)) {
      sb.classList.add('conflicted');
      sb.insertAdjacentHTML('beforeend', '<span class="conflict-flag">冲突</span>');
    }
    sCanvas.appendChild(sb);

    const aCanvas = newRow('↳ 动作', `属于「${scene.name}」`, 'action-lane', 'action-lane',
      () => { const id = addElement('action', scene.id); return id; });
    for (const act of scene.actions) {
      const ab = makeBlock(act);
      if (cSet.has(act.id)) {
        ab.classList.add('conflicted');
        ab.insertAdjacentHTML('beforeend', '<span class="conflict-flag">冲突</span>');
      }
      aCanvas.appendChild(ab);
    }
  }

  const soundCanvas = newRow('音效轨', `${v.sounds.length} 个音效`, 'sound-lane', 'sound-lane',
    () => addElement('sound'));
  for (const snd of v.sounds) {
    const sb = makeBlock(snd);
    if (cSet.has(snd.id)) {
      sb.classList.add('conflicted');
      sb.insertAdjacentHTML('beforeend', '<span class="conflict-flag">冲突</span>');
    }
    soundCanvas.appendChild(sb);
  }

  // ---- trash lane: deleted elements stay visible for conflict resolution ----
  const deleted = [...Object.values(v.elements)].filter((e) => e.deleted)
    .sort((a, b) => cmpKey(
      { lamport: a.createKey[0], clientId: a.createKey[1], opId: a.createKey[2] + '@x' },
      { lamport: b.createKey[0], clientId: b.createKey[1], opId: b.createKey[2] + '@x' },
    ));
  const trashCanvas = newRow('🗑 回收站', '并发删除的元素可在此恢复', 'trash-lane', 'trash-canvas');
  trashCanvas.style.display = 'flex';
  trashCanvas.style.alignItems = 'center';
  trashCanvas.style.gap = '8px';
  trashCanvas.style.padding = '0 12px';
  trashCanvas.style.flexWrap = 'wrap';
  if (!deleted.length) {
    trashCanvas.innerHTML = '<span class="muted small">空</span>';
  } else {
    for (const elem of deleted) {
      const chip = document.createElement('span');
      chip.className = `trash-chip${cSet.has(elem.id) ? ' conflicted' : ''}`;
      chip.innerHTML = `<b>${KIND_LABEL[elem.kind]}</b> ${elem.name}
        <button title="恢复">↩</button>`;
      chip.querySelector('button').addEventListener('click', () => restoreElement(elem.id));
      chip.addEventListener('click', () => selectElement(elem.id));
      trashCanvas.appendChild(chip);
    }
  }

  $('#empty-hint').classList.toggle('hidden',
    !!(v.scenes.length || v.sounds.length));

  renderDetail();
  renderCue();
  renderConflicts();
  renderLog();
}

// ----------------------------------------------------------------- drag ----
function onDragStart(e) {
  if (e.button !== 0 || e.target.classList.contains('block-x')) return;
  const id = e.currentTarget.dataset.id;
  const elem = state.view.elements[id];
  // document-level handlers: the block is re-created on every render, so
  // element-level pointer capture would be lost mid-drag
  state.dragging = {
    id, origX: e.clientX, origStart: elem.start,
    leftPx: elem.start * PX_PER_MS, block: e.currentTarget,
  };
  e.preventDefault();
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd, { once: true });
}
function onDragMove(e) {
  const d = state.dragging;
  if (!d) return;
  const elem = state.view.elements[d.id];
  const rawMs = d.origStart + (e.clientX - d.origX) / PX_PER_MS;
  const snapped = Math.max(0, Math.round(rawMs / SNAP_MS) * SNAP_MS);
  d.leftPx = snapped * PX_PER_MS;
  d.proposed = snapped;
  // node may have been replaced by an incoming remote render; re-find it
  d.block = document.querySelector(`.block[data-id="${CSS.escape(d.id)}"]`) || d.block;
  if (!d.block) return;
  d.block.style.left = d.leftPx + 'px';
  d.block.title = `${elem.name}（${fmtTime(snapped)} · ${elem.duration}ms）`;
}
function onDragEnd() {
  const d = state.dragging;
  state.dragging = null;
  document.removeEventListener('pointermove', onDragMove);
  if (!d) return;
  if (d.proposed !== undefined && d.proposed !== state.view.elements[d.id].start) {
    moveField(d.id, 'start', d.proposed);
  } else {
    render();
  }
}

// -------------------------------------------------------------- selection ----
function selectElement(id) {
  state.selectedId = id;
  switchTab('detail');
  render();
}

function renderDetail() {
  const form = $('#detail-form'), empty = $('#detail-empty');
  const elem = state.selectedId ? state.view.elements[state.selectedId] : null;
  if (!elem) { form.classList.add('hidden'); empty.classList.remove('hidden'); return; }
  form.classList.remove('hidden'); empty.classList.add('hidden');
  state.suppressDetail = true;
  $('#d-kind').textContent = KIND_LABEL[elem.kind] + (elem.deleted ? '（已删除）' : '');
  $('#d-name').value = elem.name;
  $('#d-start').value = fmtTime(elem.start);
  $('#d-duration').value = elem.duration;
  $('#d-id').textContent = elem.id;

  const parentRow = $('#d-parent-row');
  if (elem.kind === 'action') {
    parentRow.classList.remove('hidden');
    const sel = $('#d-parent');
    sel.innerHTML = '';
    for (const s of state.view.scenes) {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.name;
      if (s.id === elem.parent) opt.selected = true;
      sel.appendChild(opt);
    }
  } else parentRow.classList.add('hidden');

  $('#btn-delete').classList.toggle('hidden', !!elem.deleted);
  $('#btn-restore').classList.toggle('hidden', !elem.deleted);
  $('#btn-view-cue').classList.toggle('hidden', elem.kind !== 'scene' || !!elem.deleted);
  state.suppressDetail = false;
}

function bindDetail() {
  $('#d-name').addEventListener('change', (e) => {
    if (state.suppressDetail || !state.selectedId) return;
    const name = e.target.value.trim();
    if (name) renameElement(state.selectedId, name);
  });
  $('#d-start').addEventListener('change', (e) => {
    if (state.suppressDetail || !state.selectedId) return;
    const ms = parseTime(e.target.value);
    if (ms === null) { toast('时间格式错误，示例：1:02.500 或 62500', true); renderDetail(); return; }
    moveField(state.selectedId, 'start', ms);
  });
  $('#d-duration').addEventListener('change', (e) => {
    if (state.suppressDetail || !state.selectedId) return;
    const dur = Math.max(250, Math.round(parseInt(e.target.value || '0', 10) / SNAP_MS) * SNAP_MS);
    moveField(state.selectedId, 'duration', dur);
  });
  $('#d-parent').addEventListener('change', (e) => {
    if (state.suppressDetail || !state.selectedId) return;
    moveField(state.selectedId, 'parent', e.target.value);
  });
  $('#btn-delete').addEventListener('click', () => removeElement(state.selectedId));
  $('#btn-restore').addEventListener('click', () => restoreElement(state.selectedId));
}

// ------------------------------------------------- read-only cue sheet ----
// 复用 fold 视图的可见性规则（删除过滤、父场次隐藏）；本模块只读取 state.view，
// 选择场次 / 点击提示 / 打印都不会发出任何协作操作。
function effectiveCueSceneId() {
  const scenes = state.view.scenes;
  if (!scenes.length) return null;
  if (scenes.some((s) => s.id === state.cueSceneId)) return state.cueSceneId;
  const sel = state.view.elements[state.selectedId];
  if (sel && sel.kind === 'scene' && !sel.deleted && scenes.some((s) => s.id === sel.id))
    return sel.id;
  return scenes[0].id;
}

function cueRangeText(sheet) {
  return `${fmtTime(sheet.start)} – ${fmtTime(sheet.end)}（半开区间，时长 ${fmtTime(sheet.duration)}）`;
}

// 屏幕与打印共用的表格；data-id 行可在屏幕侧点击定位元素
function buildCueTable(sheet, { clickable } = {}) {
  const table = document.createElement('table');
  table.className = 'cue-table';
  table.innerHTML = `<thead><tr>
      <th class="c-rel">相对时间</th>
      <th class="c-kind">类型</th>
      <th class="c-name">名称</th>
      <th class="c-dur">时长</th>
    </tr></thead>`;
  const body = document.createElement('tbody');
  if (!sheet.cues.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="4" class="cue-empty">该场次时间范围内没有开始的动作或音效</td>';
    body.appendChild(tr);
  }
  for (const cue of sheet.cues) {
    const tr = document.createElement('tr');
    tr.dataset.id = cue.id;
    tr.title = `绝对开始 ${fmtTime(cue.start)} · ${cue.kind === 'action' ? '属于「'
      + (state.view.elements[cue.parent]?.name || shortId(cue.parent)) + '」' : '独立音效'}`;
    tr.innerHTML = `<td class="c-rel mono">${fmtTime(cue.rel)}</td>
      <td class="c-kind"><span class="cue-tag ${cue.kind}-tag">${KIND_LABEL[cue.kind]}</span></td>
      <td class="c-name">${cue.name}</td>
      <td class="c-dur mono">${fmtTime(cue.duration)}</td>`;
    if (clickable) {
      tr.classList.add('cue-row');
      if (cue.id === state.selectedId) tr.classList.add('selected');
      tr.addEventListener('click', () => {
        state.selectedId = cue.id;           // 仅本地选中，不切换标签、不发操作
        render();
      });
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  return table;
}

function renderCue() {
  if (!state.view) return;
  const select = $('#cue-scene');
  const scenes = state.view.scenes;
  const id = effectiveCueSceneId();
  state.cueSceneId = id;

  // 仅在场次列表变化时重建下拉框，避免打断选择
  const opts = scenes.map((s) => s.id).join('|');
  if (select.dataset.opts !== opts) {
    select.innerHTML = '';
    for (const s of scenes) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name}（${fmtTime(s.start)} 起）`;
      select.appendChild(opt);
    }
    select.dataset.opts = opts;
  }
  select.value = id || '';
  select.disabled = !id;
  $('#btn-cue-print').disabled = !id;

  const box = $('#cue-content');
  box.innerHTML = '';
  if (!id) {
    box.innerHTML = '<div class="muted small pad">还没有场次 —— 先在时间线上「＋ 场次」，再来生成提示单。</div>';
    return;
  }
  const sheet = buildCueSheet(state.view, id);
  if (!sheet) return;

  const head = document.createElement('div');
  head.className = 'cue-head pad';
  head.innerHTML = `<div class="cue-title"></div>
    <div class="cue-range small muted"></div>
    <div class="cue-count small muted"></div>
    <div class="cue-note small muted">只读视图：按时间线顺序列出本场次时间范围内「开始」的可见动作与音效；
      不产生协作操作，可直接打印或另存为 PDF。</div>`;
  head.querySelector('.cue-title').textContent = `📋 ${sheet.sceneName} · 提示单`;
  head.querySelector('.cue-range').textContent = cueRangeText(sheet);
  head.querySelector('.cue-count').textContent = `共 ${sheet.cues.length} 条提示`;
  box.appendChild(head);
  box.appendChild(buildCueTable(sheet, { clickable: true }));
}

function prepareCuePrint() {
  const id = effectiveCueSceneId();
  if (!id) return false;
  const sheet = buildCueSheet(state.view, id);
  if (!sheet) return false;

  const host = $('#cue-print');
  host.innerHTML = '';
  const doc = document.createElement('div');
  doc.className = 'cue-doc';
  doc.innerHTML = `<h1></h1>
    <h2></h2>
    <p class="cue-doc-meta"></p>
    <p class="cue-doc-note"></p>`;
  doc.querySelector('h1').textContent = `场次提示单 · ${state.title || '未命名剧目'}`;
  doc.querySelector('h2').textContent = sheet.sceneName;
  doc.querySelector('.cue-doc-meta').textContent =
    `时间范围：${cueRangeText(sheet)}　｜　共 ${sheet.cues.length} 条提示　｜　生成时间：${new Date().toLocaleString()}`;
  doc.querySelector('.cue-doc-note').textContent =
    '相对时间均自本场次起点（0:00.000）计算；仅列出在半开区间 [起点, 终点) 内开始的可见动作与音效。';
  doc.appendChild(buildCueTable(sheet, { clickable: false }));
  host.appendChild(doc);
  host.classList.remove('hidden');
  document.body.classList.add('printing');
  return true;
}

function teardownCuePrint() {
  document.body.classList.remove('printing');
  const host = $('#cue-print');
  host.classList.add('hidden');
  host.innerHTML = '';
}

function printCueSheet() {
  if (!prepareCuePrint()) { toast('还没有可打印的场次', true); return; }
  // 打印对话框关闭后清理；afterprint 不触发时由定时器兜底
  const cleanup = () => { teardownCuePrint(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  setTimeout(teardownCuePrint, 60000);
  window.print();
}

function bindCue() {
  // 原生 Ctrl+P：正停留在提示单标签时，打印只读提示单而非时间线
  window.addEventListener('beforeprint', () => {
    if ($('#panel-cue').classList.contains('hidden')) return;
    prepareCuePrint();
  });
  window.addEventListener('afterprint', teardownCuePrint);
  $('#tab-cue').addEventListener('click', () => switchTab('cue'));
  $('#cue-scene').addEventListener('change', (e) => {
    state.cueSceneId = e.target.value;   // 纯本地选择，不进入操作日志
    renderCue();
  });
  $('#btn-cue-print').addEventListener('click', printCueSheet);
  $('#btn-view-cue').addEventListener('click', () => {
    if (state.selectedId) state.cueSceneId = state.selectedId;
    switchTab('cue');
    renderCue();
  });
}


// ------------------------------------------------------------- conflicts ----
function fmtField(field) {
  return { name: '名称', start: '开始时间', duration: '时长', parent: '所属场次' }[field] || field;
}
function fmtValue(elem, field, value) {
  if (field === 'start') return fmtTime(value);
  if (field === 'duration') return value + ' ms';
  if (field === 'parent') return state.view.elements[value]?.name || shortId(value);
  return String(value);
}
function whoTag(cid) {
  const w = who(cid);
  return `<span class="who"><i style="background:${w.color}"></i>${w.name}</span>`;
}

function renderConflicts() {
  const list = $('#conflict-list');
  const cs = state.view ? state.view.conflicts : [];
  const badge = $('#conflict-count');
  badge.textContent = cs.length;
  badge.classList.toggle('hidden', cs.length === 0);
  list.innerHTML = '';
  if (!cs.length) {
    list.innerHTML = '<div class="muted small pad">当前没有冲突 🎉</div>';
    return;
  }
  for (const c of cs) {
    const elem = state.view.elements[c.elemId];
    const item = document.createElement('div');
    item.className = 'conflict-item';
    const title = elem ? `${KIND_LABEL[elem.kind]}「${elem.name}」` : shortId(c.elemId);

    if (c.kind === 'edit') {
      item.innerHTML = `<div class="c-title">并发修改 · ${title} 的${fmtField(c.field)}</div>
        <div class="muted small">已按 Lamport 时间戳确定性采纳一个值，可手动选择保留：</div>`;
      for (const cand of c.candidates) {
        const isW = cand.opId === c.winnerOpId;
        const row = document.createElement('div');
        row.className = 'cand' + (isW ? ' winner' : '');
        row.innerHTML = `${whoTag(cand.clientId)}
          <span>${fmtValue(elem, c.field, cand.value)}</span>
          ${isW ? '<span class="small muted">✓ 当前值</span>' : ''}`;
        if (!isW) {
          const btn = document.createElement('button');
          btn.textContent = '采用此值';
          btn.addEventListener('click', () => {
            const type = c.field === 'name' ? 'rename' : 'move';
            emitOp(type, elem.kind, elem.id, { [c.field]: cand.value });
          });
          row.appendChild(btn);
        }
        item.appendChild(row);
      }
    } else if (c.kind === 'delete') {
      item.innerHTML = `<div class="c-title">删除与编辑冲突 · ${title}</div>
        <div class="muted small">一方删除了元素，另一方同时做了编辑。确定性结果为${elem.deleted ? '「已删除」' : '「保留」'}。</div>`;
      const row = document.createElement('div');
      row.className = 'cand';
      row.innerHTML = `${whoTag(c.deleteClientId)}<span>🗑 删除</span>`;
      item.appendChild(row);
      for (const ed of c.edits) {
        const r = document.createElement('div');
        r.className = 'cand';
        r.innerHTML = `${whoTag(ed.clientId)}<span>✏️ ${ed.type === 'move' ? '移动' : '重命名'}</span>`;
        item.appendChild(r);
      }
      const actions = document.createElement('div');
      actions.className = 'btn-row pad';
      actions.style.padding = '8px 0 0';
      const keep = document.createElement('button');
      keep.textContent = elem.deleted ? '恢复元素' : '保留元素';
      keep.className = 'primary';
      keep.addEventListener('click', () => restoreElement(c.elemId));
      const del = document.createElement('button');
      del.textContent = '再次删除（以删除为准）';
      del.className = 'danger';
      del.addEventListener('click', () => removeElement(c.elemId));
      actions.append(keep, del);
      item.appendChild(actions);
    } else { // delete-restore
      item.innerHTML = `<div class="c-title">删除 / 恢复冲突 · ${title}</div>
        <div class="muted small">删除与恢复并发发生，当前确定性结果：${c.resolvedAs === 'deleted' ? '已删除' : '保留'}。</div>`;
      for (const op of c.ops) {
        const r = document.createElement('div');
        r.className = 'cand';
        r.innerHTML = `${whoTag(op.clientId)}<span>${op.type === 'delete' ? '🗑 删除' : '♻️ 恢复'}</span>`;
        item.appendChild(r);
      }
      const actions = document.createElement('div');
      actions.className = 'btn-row';
      actions.style.padding = '8px 0 0';
      const keep = document.createElement('button');
      keep.textContent = '恢复';
      keep.className = 'primary';
      keep.addEventListener('click', () => restoreElement(c.elemId));
      const del = document.createElement('button');
      del.textContent = '删除';
      del.className = 'danger';
      del.addEventListener('click', () => removeElement(c.elemId));
      actions.append(keep, del);
      item.appendChild(actions);
    }
    list.appendChild(item);
  }
}

// ------------------------------------------------------------------- log ----
function renderLog() {
  const box = $('#log-list');
  const pending = new Set(state.queue.map((o) => o.opId));
  const ops = [...state.ops.values()].sort((a, b) => cmpKey(b, a)).slice(0, 200);
  box.innerHTML = '';
  for (const op of ops) {
    const line = document.createElement('div');
    line.className = 'log-line' + (pending.has(op.opId) ? ' pending' : '');
    const elem = state.view.elements[op.elemId];
    const w = who(op.clientId);
    let detail = '';
    if (op.type === 'add' || op.type === 'rename') detail = op.payload?.name ?? '';
    else if (op.type === 'move')
      detail = Object.entries(op.payload || {}).map(([k, v]) =>
        `${fmtField(k)}=${fmtValue(elem, k, v)}`).join(', ');
    line.innerHTML = `<span class="lo-id mono">L${op.lamport} ${shortId(op.opId)}</span>
      <i style="width:8px;height:8px;border-radius:50%;background:${w.color};display:inline-block"></i>
      <span>${op.type} · ${KIND_LABEL[op.kind]}「${elem?.name ?? shortId(op.elemId)}」 ${detail}</span>`;
    line.addEventListener('click', () => selectElement(op.elemId));
    line.style.cursor = 'pointer';
    box.appendChild(line);
  }
}

// ------------------------------------------------------------------ tabs ----
function switchTab(name) {
  for (const t of ['detail', 'cue', 'conflict', 'log']) {
    $(`#tab-${t}`).classList.toggle('active', t === name);
    $(`#panel-${t}`).classList.toggle('hidden', t !== name);
  }
}
function bindTabs() {
  $('#tab-detail').addEventListener('click', () => switchTab('detail'));
  $('#tab-cue').addEventListener('click', () => switchTab('cue'));
  $('#tab-conflict').addEventListener('click', () => switchTab('conflict'));
  $('#tab-log').addEventListener('click', () => switchTab('log'));
}

// --------------------------------------------------------- import/export ----
async function doExport() {
  const all = [...state.ops.values()].sort((a, b) => cmpKey(a, b));
  const doc = {
    format: 'rehearsal-timeline/v1',
    playId: state.playId,
    title: state.title,
    exportedAt: Date.now() / 1000,
    timeUnit: 'ms',
    snapshot: state.view,
    operations: all,
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.title || 'rehearsal'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出 JSON（离线也可导出本地视图）');
}

async function doImport(file) {
  if (!state.connected) { toast('导入需要在线连接，请等待重连', true); return; }
  try {
    const doc = JSON.parse(await file.text());
    if (!doc || !Array.isArray(doc.operations)) throw new Error('缺少 operations');
    const res = await fetch(`/api/plays/${state.playId}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.status);
    const data = await res.json();
    state.ws.send(JSON.stringify({ type: 'snapshot', vv: state.serverVV }));
    toast(`导入完成：新增 ${data.imported} 条，跳过 ${data.skipped} 条重复`);
  } catch (err) {
    toast('导入失败：' + err.message, true);
  }
}

// ------------------------------------------------------------ join / play ----
async function loadPlayList() {
  const box = $('#play-list');
  try {
    const plays = await (await fetch('/api/plays')).json();
    box.innerHTML = '';
    if (!plays.length) { box.innerHTML = '<div class="muted small pad">暂无剧目，请新建</div>'; return; }
    for (const p of plays) {
      const item = document.createElement('div');
      item.className = 'play-item';
      item.innerHTML = `<span>${p.title}</span><span class="muted small mono">${shortId(p.playId)}</span>`;
      item.addEventListener('click', () => enterPlay(p.playId, p.title));
      box.appendChild(item);
    }
  } catch {
    box.innerHTML = '<div class="muted small pad">无法连接服务端</div>';
  }
}

async function createPlay() {
  const title = $('#join-title').value.trim() || '未命名剧目';
  const res = await fetch('/api/plays', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const p = await res.json();
  enterPlay(p.playId, p.title);
}

function enterPlay(playId, title) {
  state.playId = playId;
  state.title = title;
  state.ops = new Map((LS.get(opsKey(playId), [])).map((o) => [o.opId, o]));
  state.queue = LS.get(queueKey(playId), []);
  state.serverVV = {};
  state.selectedId = null;
  state.cueSceneId = null;
  location.hash = `#/play/${playId}`;
  $('#join-overlay').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#play-title').textContent = title;
  ensureProfile();
  recompute();
  render();
  connect();
}

function leavePlay() {
  state.closing = true;
  clearTimeout(state.retryTimer);
  if (state.ws) { try { state.ws.close(); } catch {} }
  state.connected = false;
  state.playId = null;
  $('#app').classList.add('hidden');
  $('#join-overlay').classList.remove('hidden');
  location.hash = '';
  loadPlayList();
}

// --------------------------------------------------------------- bootstrap --
function bindChrome() {
  $('#btn-new-play').addEventListener('click', createPlay);
  $('#btn-switch-play').addEventListener('click', leavePlay);
  $('#btn-add-scene').addEventListener('click', () => { state.selectedId = addElement('scene'); render(); });
  $('#btn-add-sound').addEventListener('click', () => { state.selectedId = addElement('sound'); render(); });
  $('#btn-export').addEventListener('click', doExport);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) doImport(e.target.files[0]);
    e.target.value = '';
  });
  $('#play-title').addEventListener('click', async () => {
    const title = prompt('修改剧目名称', state.title);
    if (!title || !state.connected) return;
    const res = await fetch(`/api/plays/${state.playId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });
    if (res.ok) { state.title = title.trim(); $('#play-title').textContent = state.title; }
  });
  bindTabs();
  bindDetail();
  bindCue();
}

(async function init() {
  ensureProfile();
  const saved = LS.get('rt:profile', {});
  $('#join-name').value = saved.name || '';
  $('#join-name').addEventListener('change', (e) => {
    state.profile.name = e.target.value.trim();
    LS.set('rt:profile', state.profile);
  });
  bindChrome();

  const m = location.hash.match(/^#\/play\/([\w-]+)/);
  if (m) {
    try {
      const res = await fetch(`/api/plays/${m[1]}/state`);
      if (res.ok) {
        const meta = await (await fetch('/api/plays')).json();
        const p = meta.find((x) => x.playId === m[1]);
        enterPlay(m[1], p ? p.title : '未命名剧目');
        return;
      }
    } catch {}
  }
  $('#join-overlay').classList.remove('hidden');
  loadPlayList();
})();

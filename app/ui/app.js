/* Personal AI app UI — plain DOM, zero build.
 * Talks to the local bridge: POST /cmd for commands, /events (SSE) for the
 * live record stream. The UI never knows which body is underneath. */
'use strict';

const $ = (id) => document.getElementById(id);
let cmdSeq = 0;
let busy = false;
let assistantEl = null; // live message bubble being streamed into

async function cmd(type, params = {}) {
  const res = await fetch('/cmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: `u${++cmdSeq}`, type, ...params }),
  });
  return res.json();
}

/* ---------- transcript rendering ---------- */
function addMsg(who, text) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.innerHTML = `<div class="who">${who === 'user' ? '你' : 'assistant'}</div><div class="bubble"></div>`;
  div.querySelector('.bubble').textContent = text;
  $('transcript').appendChild(div);
  div.scrollIntoView({ block: 'end' });
  return div;
}
function addSys(text) {
  const div = document.createElement('div');
  div.className = 'sys';
  div.textContent = text;
  $('transcript').appendChild(div);
}
function addTool(name, id) {
  const div = document.createElement('div');
  div.className = 'tool';
  div.dataset.tool = id;
  div.textContent = `⚙ ${name}`;
  $('transcript').appendChild(div);
  div.scrollIntoView({ block: 'end' });
}
function messageText(m) {
  const blocks = m?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
}

/* ---------- agent events ---------- */
function onAgentEvent(ev) {
  switch (ev?.type) {
    case 'agent_start':
      busy = true;
      setStatus('运行中…');
      assistantEl = null;
      break;
    case 'message_start':
      assistantEl = addMsg('assistant', '');
      break;
    case 'message_update': {
      const text = messageText(ev.message);
      if (text) {
        (assistantEl ??= addMsg('assistant', '')).querySelector('.bubble').textContent = text;
        assistantEl.scrollIntoView({ block: 'end' });
      }
      break;
    }
    case 'tool_execution_start':
      addTool(ev.toolName, ev.toolCallId);
      break;
    case 'tool_execution_end': {
      const el = document.querySelector(`[data-tool="${ev.toolCallId}"]`);
      if (el) el.classList.add(ev.isError ? 'err' : 'done');
      break;
    }
    case 'agent_end':
      busy = false;
      assistantEl = null;
      setStatus('就绪');
      refreshState();
      break;
  }
}

/* ---------- supervisor events ---------- */
const PHASES = ['prepared', 'quiesced', 'checkpointed', 'released', 'acquired', 'resumed', 'verified'];
function onSupervisor(ev) {
  if (ev.kind === 'handoff_phase') {
    const box = $('handoff');
    box.classList.remove('hidden');
    box.innerHTML = `切换 ${ev.handoffId}<br>` + PHASES.map((p) => {
      const cls = ev.phase === 'failed' && p === ev.phase ? 'fail'
        : PHASES.indexOf(p) <= PHASES.indexOf(ev.phase) ? 'done' : '';
      return `<div class="phase ${cls}">${cls === 'done' ? '✓' : '·'} ${p}</div>`;
    }).join('') + (ev.reason ? `<div class="phase fail">${ev.reason}</div>` : '');
    addSys(`身体切换 ${ev.phase}${ev.reason ? `：${ev.reason}` : ''}`);
  } else if (ev.kind === 'select_done') {
    setStatus('就绪');
    $('handoff').classList.add('hidden');
    addSys(`已切换到身体 ${ev.to}（${ev.mode}）`);
    refreshAll();
  } else if (ev.kind === 'select_failed' || ev.kind === 'body_exited') {
    setStatus('注意');
    addSys(`身体事件：${ev.kind} ${ev.error ?? ev.body ?? ''}`);
    refreshAll();
  }
}

/* ---------- audit / jobs ---------- */
async function refreshAudit() {
  const r = await cmd('audit_tail', { n: 60 });
  const list = $('audit-list');
  list.innerHTML = '';
  for (const e of (r.data ?? []).slice().reverse()) {
    const div = document.createElement('div');
    div.className = 'audit-row';
    const ts = (e.ts ?? e.time ?? '').slice(11, 19);
    div.innerHTML = `<b>${e.kind}</b> <span>${ts}</span> <span>${e.runId ? `run ${String(e.runId).slice(0, 8)}` : ''}</span>`;
    list.appendChild(div);
  }
}
async function refreshJobs() {
  const r = await cmd('job_list', { n: 50 });
  const tbody = $('jobs').querySelector('tbody');
  tbody.innerHTML = '';
  for (const j of r.data ?? []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${j.job_id?.slice(0, 12) ?? ''}</td><td>${j.job_type ?? ''}</td><td>${j.job_state ?? ''}</td><td>${(j.updated_at ?? '').slice(0, 19).replace('T', ' ')}</td>`;
    tbody.appendChild(tr);
  }
}

/* ---------- body panel ---------- */
async function refreshBodies() {
  const r = await cmd('body_list');
  const box = $('bodies');
  box.innerHTML = '';
  for (const b of r.data ?? []) {
    const card = document.createElement('div');
    card.className = `body-card${b.current ? ' current' : ''}`;
    const caps = b.facts?.verified_capabilities ?? {};
    const capHtml = Object.entries(caps)
      .map(([k, v]) => `<span class="cap ${v}" title="${k}">${k.replaceAll('_', ' ')}</span>`)
      .join('');
    const elig = b.eligibility ?? {};
    const eligHtml = [
      ...(elig.failClosed ?? []).map((f) => `<div class="fc">✗ ${f.invariant}: ${f.reason}</div>`),
      ...(elig.degraded ?? []).map((d) => `<div class="dg">△ ${d}</div>`),
    ].join('');
    card.innerHTML = `
      <div class="name">${b.label}
        ${b.current ? '<span class="badge on">当前</span>' : ''}
        ${b.installed ? '<span class="badge">已装</span>' : '<span class="badge err">未安装</span>'}
        ${b.has_channel ? '' : '<span class="badge warn">无会话通道</span>'}
      </div>
      <div class="caps">${capHtml}</div>
      <div class="elig">${eligHtml || '<span>符合当前任务画像</span>'}</div>
      ${b.current ? '' : `<button data-body="${b.body_id}">使用这个身体</button>`}
      ${b.installed ? '' : `<div class="elig">${b.install_hint ?? ''}</div>`}
    `;
    const btn = card.querySelector('button[data-body]');
    if (btn) {
      btn.onclick = async () => {
        btn.disabled = true;
        addSys(`请求切换到 ${b.body_id}…`);
        const r2 = await cmd('body_select', { body_id: b.body_id });
        if (!r2.success) {
          addSys(`切换被拒：${r2.error ?? '未知原因'}`);
          btn.disabled = false;
        }
        refreshBodies();
      };
    }
    box.appendChild(card);
  }
}
async function refreshState() {
  const r = await cmd('get_state');
  const s = r.data ?? {};
  $('state').innerHTML = [
    `模型：${s.model ? `${s.model.provider}/${s.model.id}` : '—'}`,
    `流式：${s.streaming ? '是' : '否'}`,
    `消息数：${s.messageCount ?? '—'}`,
  ].map((x) => `<div>${x}</div>`).join('');
}
async function refreshCurrent() {
  const r = await cmd('body_current');
  $('current-body').textContent = r.data?.body_id ?? '无身体';
}
function refreshAll() { refreshBodies(); refreshCurrent(); refreshState(); refreshJobs(); refreshAudit(); }
function setStatus(t) { $('status').textContent = t; }

/* ---------- wire-up ---------- */
$('send').onclick = send;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
async function send() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  addMsg('user', text);
  const r = await cmd('prompt', { message: text });
  if (!r.success) addSys(`发送失败：${r.error ?? '未知'}`);
}
$('steer').onclick = async () => {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  const r = await cmd('steer', { message: text });
  if (!r.success) addSys(`插话失败：${r.error ?? '未知'}`);
};
$('abort').onclick = () => cmd('abort');
$('jobs-refresh').onclick = refreshJobs;
$('audit-refresh').onclick = refreshAudit;
for (const [tab, view] of [['tab-chat', 'view-chat'], ['tab-jobs', 'view-jobs'], ['tab-audit', 'view-audit']]) {
  $(tab).onclick = () => {
    for (const t of ['tab-chat', 'tab-jobs', 'tab-audit']) $(t).classList.toggle('active', t === tab);
    for (const v of ['view-chat', 'view-jobs', 'view-audit']) $(v).classList.toggle('hidden', v !== view);
  };
}

const es = new EventSource('/events');
es.onmessage = (m) => {
  const rec = JSON.parse(m.data);
  if (rec.type === 'event') onAgentEvent(rec.event);
  else if (rec.type === 'audit') refreshAuditSoon();
  else if (rec.type === 'supervisor') onSupervisor(rec.event);
};
let auditTimer = null;
function refreshAuditSoon() {
  clearTimeout(auditTimer);
  auditTimer = setTimeout(refreshAudit, 400);
}
es.onerror = () => setStatus('连接断开，重试中…');
es.onopen = () => setStatus('就绪');

refreshAll();

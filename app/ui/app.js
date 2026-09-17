/* Personal AI app UI — plain DOM, zero build.
 * Talks to the local bridge: POST /cmd for commands, /events (SSE) for the
 * live record stream. The UI never knows which body is underneath. */
'use strict';

const $ = (id) => document.getElementById(id);
let cmdSeq = 0;
let busy = false;
let assistantEl = null; // live message bubble being streamed into
let sawMessage = false;
let nearBottom = true;

async function cmd(type, params = {}) {
  const res = await fetch('/cmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: `u${++cmdSeq}`, type, ...params }),
  });
  return res.json();
}

/* ---------- scroll follow: only pinned when the user is at the tail ---------- */
const transcript = $('transcript');
function isNearBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
}
transcript.addEventListener('scroll', () => {
  nearBottom = isNearBottom();
  $('jump-latest').classList.toggle('show', !nearBottom && sawMessage);
});
function scrollTail() {
  if (!nearBottom) { $('jump-latest').classList.add('show'); return; }
  transcript.scrollTop = transcript.scrollHeight;
}
$('jump-latest').onclick = () => {
  nearBottom = true;
  $('jump-latest').classList.remove('show');
  transcript.scrollTop = transcript.scrollHeight;
};

/* ---------- minimal markdown (safe: escape first, then structure) ---------- */
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inlineMd(s) {
  return escHtml(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}
function md(text) {
  const parts = String(text).split(/```([\s\S]*?)```/g);
  return parts.map((seg, i) => {
    if (i % 2 === 1) {
      const code = seg.replace(/^[^\n]*\n/, '');
      return `<pre><button class="code-copy">复制</button><code>${escHtml(code)}</code></pre>`;
    }
    const lines = seg.split('\n');
    let html = '';
    let list = null; // 'ul' | 'ol' | null
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw;
      let m;
      if ((m = line.match(/^\s*[-*]\s+(.+)/))) {
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += `<li>${inlineMd(m[1])}</li>`;
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.+)/))) {
        if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
        html += `<li>${inlineMd(m[1])}</li>`;
      } else if ((m = line.match(/^#{1,4}\s+(.+)/))) {
        closeList(); html += `<div class="md-h">${inlineMd(m[1])}</div>`;
      } else if ((m = line.match(/^>\s?(.*)/))) {
        closeList(); html += `<blockquote>${inlineMd(m[1])}</blockquote>`;
      } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
        closeList(); html += '<hr>';
      } else {
        closeList(); html += `${inlineMd(line)}\n`;
      }
    }
    closeList();
    return html;
  }).join('');
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.code-copy');
  if (!btn) return;
  const code = btn.parentElement?.querySelector('code')?.textContent ?? '';
  navigator.clipboard?.writeText(code).then(() => {
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 1400);
  });
});

/* ---------- transcript rendering ---------- */
const CARET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const TOOL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z"/></svg>';

function noteMessage() {
  if (!sawMessage) { sawMessage = true; $('empty-state')?.remove(); }
}
function addMsg(who, text) {
  noteMessage();
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.innerHTML = '<div class="bubble"></div>';
  const b = div.querySelector('.bubble');
  if (who === 'user') b.textContent = text; else b.innerHTML = md(text);
  transcript.appendChild(div);
  scrollTail();
  return div;
}
function addSys(text, bad = false) {
  noteMessage();
  const div = document.createElement('div');
  div.className = `sys${bad ? ' bad' : ''}`;
  div.textContent = text;
  transcript.appendChild(div);
  scrollTail();
}

/* one-line signature of a tool call: first meaningful arg preview */
function argPreview(args) {
  if (args == null) return '';
  const pick = args.path ?? args.file ?? args.command ?? args.cmd ?? args.url
    ?? args.query ?? args.prompt ?? args.name ?? null;
  if (pick != null) return String(pick);
  const s = JSON.stringify(args);
  return s === '{}' ? '' : s;
}
function resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const blocks = result?.content;
  if (Array.isArray(blocks)) {
    const t = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
    if (t) return t;
  }
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}
const toolRows = new Map(); // toolCallId → element
function addTool(ev) {
  noteMessage();
  const div = document.createElement('div');
  div.className = 'tool running';
  div.dataset.tool = ev.toolCallId;
  const arg = argPreview(ev.args);
  div.innerHTML = `
    <button class="tool-head">
      <span class="t-caret">${CARET}</span>
      <span class="t-icon">${TOOL_ICON}</span>
      <span class="t-name running"></span>
      <span class="t-arg"></span>
      <span class="t-state"><span class="t-state-dot"></span><span class="t-label">运行中</span></span>
      <span class="t-copy" title="复制调用">${COPY_ICON}</span>
    </button>
    <div class="tool-body"></div>`;
  div.querySelector('.t-name').textContent = ev.toolName;
  div.querySelector('.t-arg').textContent = arg.length > 90 ? `${arg.slice(0, 90)}…` : arg;
  const body = div.querySelector('.tool-body');
  const argsStr = (() => { try { return JSON.stringify(ev.args, null, 2); } catch { return String(ev.args); } })();
  if (argsStr && argsStr !== '{}') body.innerHTML = `<div class="tb-label">入参</div><pre></pre>`;
  const argPre = body.querySelector('pre');
  if (argPre) argPre.textContent = argsStr;
  div.querySelector('.tool-head').onclick = () => div.classList.toggle('open');
  div.querySelector('.t-copy').onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(`${ev.toolName} ${argsStr ?? ''}`).then(() => {
      e.currentTarget.classList.add('copied');
      setTimeout(() => e.currentTarget.classList.remove('copied'), 1200);
    });
  };
  toolRows.set(ev.toolCallId, div);
  transcript.appendChild(div);
  scrollTail();
}
function endTool(ev) {
  const el = toolRows.get(ev.toolCallId) ?? document.querySelector(`[data-tool="${ev.toolCallId}"]`);
  if (!el) return;
  el.classList.remove('running');
  el.classList.add(ev.isError ? 'err' : 'done');
  el.querySelector('.t-name').classList.remove('running');
  el.querySelector('.t-label').textContent = ev.isError ? '失败' : '完成';
  const out = resultText(ev.result);
  if (out) {
    const body = el.querySelector('.tool-body');
    body.insertAdjacentHTML('beforeend',
      `<div class="tb-label">输出</div><pre class="${ev.isError ? 't-err' : ''}"></pre>`);
    const pres = body.querySelectorAll('pre');
    pres[pres.length - 1].textContent = out.length > 6000 ? `${out.slice(0, 6000)}\n…（截断）` : out;
  }
  toolRows.delete(ev.toolCallId);
  scrollTail();
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
      setBusy(true);
      assistantEl = null;
      break;
    case 'message_start':
      assistantEl = addMsg('assistant', '');
      break;
    case 'message_update': {
      const text = messageText(ev.message);
      if (text) {
        (assistantEl ??= addMsg('assistant', '')).querySelector('.bubble').innerHTML = md(text);
        scrollTail();
      }
      break;
    }
    case 'tool_execution_start':
      addTool(ev);
      break;
    case 'tool_execution_update': {
      const el = toolRows.get(ev.toolCallId);
      if (el && ev.partialResult) {
        const body = el.querySelector('.tool-body');
        let live = body.querySelector('pre.t-live');
        if (!live) {
          body.insertAdjacentHTML('beforeend', '<div class="tb-label">进行中</div><pre class="t-live"></pre>');
          live = body.querySelector('pre.t-live');
        }
        live.textContent = resultText(ev.partialResult).slice(0, 4000);
      }
      break;
    }
    case 'tool_execution_end':
      endTool(ev);
      break;
    case 'agent_end':
      setBusy(false);
      assistantEl = null;
      refreshState();
      break;
  }
}

function setBusy(v) {
  busy = v;
  $('send').classList.toggle('hidden', v);
  $('abort').classList.toggle('hidden', !v);
  $('steer').disabled = !v;
  setStatus(v ? '运行中…' : '就绪');
}

/* ---------- supervisor events ---------- */
const PHASES = ['prepared', 'quiesced', 'checkpointed', 'released', 'acquired', 'resumed', 'verified'];
let handoffEl = null;
function onSupervisor(ev) {
  if (ev.kind === 'handoff_phase' || ev.kind === 'select_start') {
    $('switch-progress').classList.add('on');
    noteMessage();
    if (!handoffEl) {
      handoffEl = document.createElement('div');
      handoffEl.className = 'handoff-card';
      transcript.appendChild(handoffEl);
    }
    const at = ev.phase ? PHASES.indexOf(ev.phase) : -1;
    handoffEl.innerHTML = '身体切换 · ' + (ev.handoffId ?? '') + '<br>' + PHASES.map((p, i) => {
      const cls = ev.phase === 'failed' ? (i <= at ? 'done' : '')
        : i < at ? 'done' : i === at ? 'now' : '';
      return `<span class="ph ${cls}">${cls === 'done' ? '✓' : '·'} ${p}</span>`;
    }).join('') + (ev.phase === 'failed' ? `<div class="ph fail">${ev.reason ?? ''}</div>` : '');
    scrollTail();
    if (ev.phase === 'failed') addSys(`身体切换失败：${ev.reason ?? '未知'}`, true);
  } else if (ev.kind === 'select_done') {
    $('switch-progress').classList.remove('on');
    handoffEl = null;
    setStatus('就绪');
    addSys(`已切换到身体 ${ev.to}（${ev.mode}）`);
    refreshAll();
  } else if (ev.kind === 'select_failed' || ev.kind === 'body_exited') {
    $('switch-progress').classList.remove('on');
    handoffEl = null;
    setStatus('注意', 'err');
    addSys(`身体事件：${ev.kind} ${ev.error ?? ev.body ?? ''}`, true);
    refreshAll();
  }
}

/* ---------- audit / jobs ---------- */
async function refreshAudit() {
  const r = await cmd('audit_tail', { n: 60 });
  const list = $('audit-list');
  list.innerHTML = '';
  const rows = (r.data ?? []).slice().reverse();
  if (!rows.length) list.innerHTML = '<div class="sys">暂无审计事件</div>';
  for (const e of rows) {
    const div = document.createElement('div');
    div.className = 'audit-row';
    const ts = (e.ts ?? e.time ?? '').slice(11, 19);
    div.innerHTML = `<b></b> <span>${ts}</span> <span>${e.runId ? `run ${String(e.runId).slice(0, 8)}` : ''}</span>`;
    div.querySelector('b').textContent = e.kind ?? '';
    list.appendChild(div);
  }
}
async function refreshJobs() {
  const r = await cmd('job_list', { n: 50 });
  const tbody = $('jobs').querySelector('tbody');
  tbody.innerHTML = '';
  const jobs = r.data ?? [];
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-4);padding:28px">暂无持久任务</td></tr>';
    return;
  }
  for (const j of jobs) {
    const tr = document.createElement('tr');
    const cells = [j.job_id?.slice(0, 12) ?? '', j.job_type ?? '', j.job_state ?? '', (j.updated_at ?? '').slice(0, 19).replace('T', ' ')];
    tr.innerHTML = cells.map(() => '<td></td>').join('');
    tr.querySelectorAll('td').forEach((td, i) => { td.textContent = cells[i]; });
    tbody.appendChild(tr);
  }
}

/* ---------- bodies ---------- */
const BODY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/><circle cx="9.5" cy="13" r="1.2" fill="currentColor"/><circle cx="14.5" cy="13" r="1.2" fill="currentColor"/></svg>';
let bodiesCache = [];

function renderSideBodies() {
  const filter = $('side-filter').value.trim().toLowerCase();
  const box = $('side-body');
  box.innerHTML = '';
  for (const b of bodiesCache) {
    if (filter && !`${b.label} ${b.body_id}`.toLowerCase().includes(filter)) continue;
    const row = document.createElement('div');
    row.className = 's-body';
    row.innerHTML = `<span class="s-dot${b.current ? ' on' : ''}"></span><span class="s-name"></span><span class="s-meta">${b.current ? '当前' : ''}</span>`;
    row.querySelector('.s-name').textContent = b.label;
    row.onclick = () => switchView('bodies');
    box.appendChild(row);
  }
}

async function refreshBodies() {
  const r = await cmd('body_list');
  const grid = $('body-grid');
  grid.innerHTML = '';
  bodiesCache = r.data ?? [];
  renderSideBodies();

  const cur = bodiesCache.find((b) => b.current);
  $('body-chip').textContent = cur ? `${cur.label} ▾` : '选择身体 ▾';

  for (const b of bodiesCache) {
    const card = document.createElement('div');
    card.className = `body-card${b.current ? ' current' : ''}`;
    const caps = b.facts?.verified_capabilities ?? {};
    const capHtml = Object.entries(caps)
      .map(([k, v]) => `<span class="cap ${v}" title="${k}">${k.replaceAll('_', ' ')}</span>`)
      .join('');
    const elig = b.eligibility ?? {};
    const notes = [
      ...(elig.failClosed ?? []).map((f) => `<div class="fc">✗ ${f.invariant} — ${f.reason}</div>`),
      ...(elig.degraded ?? []).map((d) => `<div class="dg">△ ${d}</div>`),
    ];
    const pills = [
      b.current ? '<span class="pill on">当前</span>' : '',
      b.installed ? '<span class="pill ok">已安装</span>' : '<span class="pill err">未安装</span>',
      b.has_channel ? '' : '<span class="pill warn">无会话通道</span>',
    ].join('');
    card.innerHTML = `
      <div class="bc-head">
        <div class="bc-icon">${BODY_ICON}</div>
        <div><div class="bc-title">${b.label} ${pills}</div><div class="bc-sub">${b.body_id}</div></div>
      </div>
      <div class="caps">${capHtml || '<span class="cap">无能力事实</span>'}</div>
      <div class="bc-notes">${notes.join('') || '<div class="ok-line">符合当前任务画像</div>'}</div>
      <div class="bc-foot">
        ${b.installed ? '' : `<span class="bc-hint">${b.install_hint ?? ''}</span>`}
        ${b.current ? '' : `<button class="use-btn" data-body="${b.body_id}">使用这个身体</button>`}
      </div>`;
    const btn = card.querySelector('button[data-body]');
    if (btn) {
      btn.onclick = async () => {
        btn.disabled = true;
        addSys(`请求切换到 ${b.body_id}…`);
        switchView('chat');
        const r2 = await cmd('body_select', { body_id: b.body_id });
        if (!r2.success) {
          addSys(`切换被拒：${r2.error ?? '未知原因'}`, true);
          btn.disabled = false;
        }
        refreshBodies();
      };
    }
    grid.appendChild(card);
  }
}
$('side-filter').addEventListener('input', renderSideBodies);

async function refreshState() {
  const r = await cmd('get_state');
  const s = r.data ?? {};
  $('model-chip').textContent = s.model ? `${s.model.provider}/${s.model.id}` : '';
}
function refreshAll() { refreshBodies(); refreshState(); refreshJobs(); refreshAudit(); }
function setStatus(t, kind) {
  $('status').textContent = t;
  $('status-dot').className = `dot${kind === 'err' ? ' err' : t === '就绪' ? ' on' : ''}`;
}

/* ---------- views ---------- */
const TITLES = { chat: '新建任务', bodies: '身体', jobs: '任务', audit: '审计' };
function switchView(v) {
  for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('active', item.dataset.view === v);
  for (const sec of document.querySelectorAll('.view')) sec.classList.toggle('hidden', sec.id !== `view-${v}`);
  $('view-title').textContent = TITLES[v] ?? '';
  if (v === 'jobs') refreshJobs();
  if (v === 'audit') refreshAudit();
  if (v === 'bodies') refreshBodies();
}
for (const item of document.querySelectorAll('.nav-item')) item.onclick = () => switchView(item.dataset.view);
$('body-chip').onclick = () => switchView('bodies');

/* ---------- composer ---------- */
const input = $('input');
function autogrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  $('send').disabled = busy ? false : !input.value.trim();
}
input.addEventListener('input', autogrow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); busy ? steer() : send(); }
});
async function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = ''; autogrow();
  addMsg('user', text);
  const r = await cmd('prompt', { message: text });
  if (!r.success) addSys(`发送失败：${r.error ?? '未知'}`, true);
}
async function steer() {
  const text = input.value.trim();
  if (!text) return;
  input.value = ''; autogrow();
  const r = await cmd('steer', { message: text });
  if (!r.success) addSys(`插话失败：${r.error ?? '未知'}`, true);
}
$('send').onclick = () => (busy ? steer() : send());
$('steer').onclick = steer;
$('abort').onclick = () => cmd('abort');

/* ---------- SSE ---------- */
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
es.onerror = () => setStatus('连接断开，重试中…', 'err');
es.onopen = () => setStatus('就绪');

autogrow();
refreshAll();

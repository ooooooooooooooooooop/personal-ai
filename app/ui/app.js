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
let modelStatus = null;   // last model_status payload
let sessionsCache = [];   // last session_list payload
let currentSessionFile = null;

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
    let list = null;
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const line of lines) {
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
const THINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-4 12.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3A7 7 0 0 0 12 2z"/><path d="M10 22h4"/></svg>';

function noteMessage() {
  if (!sawMessage) {
    sawMessage = true;
    $('empty-state')?.remove();
    $('setup-card')?.classList.add('hidden');
  }
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
function addThinking(text) {
  noteMessage();
  const div = document.createElement('div');
  div.className = 'think-row';
  div.innerHTML = `<button class="think-head"><span class="t-caret">${CARET}</span><span class="t-icon">${THINK_ICON}</span>思考过程</button><div class="think-body"></div>`;
  div.querySelector('.think-body').textContent = text;
  div.querySelector('.think-head').onclick = () => div.classList.toggle('open');
  transcript.appendChild(div);
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
function clearTranscript() {
  transcript.querySelectorAll('.msg,.sys,.tool,.think-row,.handoff-card').forEach((n) => n.remove());
  sawMessage = false;
  nearBottom = true;
}

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
const toolRows = new Map();
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

/* ---------- history replay (session switch / restart) ---------- */
async function replayHistory() {
  clearTranscript();
  const r = await cmd('session_history');
  const msgs = r.data ?? [];
  for (const m of msgs) {
    if (m.role === 'user') addMsg('user', m.text ?? '');
    else if (m.role === 'assistant') {
      if (m.thinking) addThinking(m.thinking);
      if (m.text) addMsg('assistant', m.text);
      for (const t of m.tools ?? []) addSys(`调用工具 ${t}`);
      if (m.error) addSys(`模型错误：${m.error}`, true);
    }
  }
  if (!sawMessage && modelStatus?.current == null) $('setup-card')?.classList.remove('hidden');
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
    case 'session_changed':
      currentSessionFile = ev.session?.file ?? null;
      replayHistory();
      refreshSessions();
      refreshState();
      break;
    case 'agent_end':
      setBusy(false);
      assistantEl = null;
      refreshState();
      refreshSessionsSoon();
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
  } else if (ev.kind === 'workdir_changed') {
    addSys(`工作目录已切换：${ev.workdir}`);
  } else if (ev.kind === 'select_failed' || ev.kind === 'body_exited') {
    $('switch-progress').classList.remove('on');
    handoffEl = null;
    setStatus('注意', 'err');
    addSys(`身体事件：${ev.kind} ${ev.error ?? ev.body ?? ''}`, true);
    refreshAll();
  }
}

/* ---------- sessions (sidebar) ---------- */
function sessionGroup(dateStr) {
  const d = dateStr ? new Date(dateStr) : null;
  if (!d || Number.isNaN(+d)) return '更早';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86400000;
  if (d >= today) return '今天';
  if (d >= today - day) return '昨天';
  if (d >= today - 7 * day) return '近 7 天';
  return '更早';
}
function renderSessions() {
  const box = $('session-list');
  const filter = $('side-filter').value.trim().toLowerCase();
  box.innerHTML = '';
  const items = sessionsCache
    .filter((s) => !filter || `${s.name ?? ''} ${s.firstMessage ?? ''}`.toLowerCase().includes(filter))
    .sort((a, b) => String(b.modified ?? '').localeCompare(String(a.modified ?? '')));
  const groups = new Map();
  for (const s of items) {
    const g = sessionGroup(s.modified);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  if (!items.length) {
    box.innerHTML = '<div class="sess-empty">还没有任务——从下方输入框开始</div>';
    return;
  }
  for (const [g, rows] of groups) {
    const h = document.createElement('div');
    h.className = 'sess-group';
    h.textContent = g;
    box.appendChild(h);
    for (const s of rows) {
      const row = document.createElement('div');
      row.className = `sess${s.path === currentSessionFile ? ' active' : ''}`;
      const title = s.name || s.firstMessage || '未命名任务';
      row.innerHTML = `<span class="sess-title"></span><span class="sess-meta">${s.messageCount ?? 0} 条</span>`;
      row.querySelector('.sess-title').textContent = title.length > 40 ? `${title.slice(0, 40)}…` : title;
      row.title = s.path;
      row.onclick = () => switchSession(s.path);
      box.appendChild(row);
    }
  }
}
async function switchSession(path) {
  if (path === currentSessionFile) { switchView('chat'); return; }
  const r = await cmd('session_switch', { path });
  if (!r.success) addSys(`切换会话失败：${r.error ?? '未知'}`, true);
  switchView('chat');
}
async function refreshSessions() {
  const r = await cmd('session_list');
  if (r.success) {
    sessionsCache = r.data ?? [];
    renderSessions();
  }
}
let sessTimer = null;
function refreshSessionsSoon() {
  clearTimeout(sessTimer);
  sessTimer = setTimeout(refreshSessions, 600);
}
$('new-task').onclick = async () => {
  const r = await cmd('session_new');
  if (!r.success) addSys(`新建会话失败：${r.error ?? '未知'}`, true);
  switchView('chat');
  $('input').focus();
};
$('side-filter').addEventListener('input', renderSessions);

/* ---------- model / thinking chips ---------- */
const chipMenu = $('chip-menu');
function closeMenu() { chipMenu.classList.add('hidden'); chipMenu.innerHTML = ''; }
document.addEventListener('click', (e) => {
  if (!chipMenu.contains(e.target) && e.target.id !== 'model-chip' && e.target.id !== 'thinking-chip') closeMenu();
});
function openMenu(items, onPick) {
  chipMenu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = `menu-item${it.current ? ' current' : ''}`;
    b.innerHTML = `<span class="mi-main"></span><span class="mi-sub"></span>`;
    b.querySelector('.mi-main').textContent = it.label;
    b.querySelector('.mi-sub').textContent = it.sub ?? '';
    b.onclick = async () => { closeMenu(); await onPick(it); };
    chipMenu.appendChild(b);
  }
  chipMenu.classList.remove('hidden');
}
$('model-chip').onclick = async () => {
  if (!chipMenu.classList.contains('hidden')) { closeMenu(); return; }
  const r = await cmd('model_list');
  const models = r.data ?? [];
  if (!models.length) {
    openMenu([{ label: '没有可用模型——去设置里配密钥', sub: '' }], () => switchView('settings'));
    return;
  }
  const cur = modelStatus?.current;
  openMenu(models.map((m) => ({
    label: m.name ?? m.id,
    sub: m.provider,
    current: cur && m.provider === cur.provider && m.id === cur.id,
    value: m,
  })), async (it) => {
    if (!it.value) return;
    const r2 = await cmd('model_set', { provider: it.value.provider, model: it.value.id });
    if (!r2.success) addSys(`切换模型失败：${r2.error ?? '未知'}`, true);
    refreshState();
  });
};
const THINK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const THINK_LABEL = { off: '关', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高' };
$('thinking-chip').onclick = () => {
  if (!chipMenu.classList.contains('hidden')) { closeMenu(); return; }
  const cur = modelStatus?.thinkingLevel ?? 'medium';
  openMenu(THINK_LEVELS.map((lv) => ({
    label: `推理 · ${THINK_LABEL[lv]}`,
    sub: lv,
    current: lv === cur,
    value: lv,
  })), async (it) => {
    const r = await cmd('thinking_set', { level: it.value });
    if (!r.success) addSys(`设置推理强度失败：${r.error ?? '未知'}`, true);
    refreshState();
  });
};

/* ---------- model setup (empty-state gate + settings) ---------- */
function fillProviderSelect(sel, providers) {
  sel.innerHTML = '';
  for (const p of providers) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.id}${p.hasAuth ? '（已配置）' : ''}`;
    sel.appendChild(o);
  }
}
function renderModelPick(box, models) {
  box.innerHTML = '';
  if (!models.length) {
    box.innerHTML = '<div class="setup-msg">保存密钥后这里会列出该提供方的模型</div>';
    return;
  }
  const cur = modelStatus?.current;
  for (const m of models) {
    const row = document.createElement('button');
    row.className = `model-row${cur && cur.provider === m.provider && cur.id === m.id ? ' current' : ''}`;
    row.innerHTML = `<span class="mr-name"></span><span class="mr-meta">${m.provider}${m.reasoning ? ' · 推理' : ''}${m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k` : ''}</span>`;
    row.querySelector('.mr-name').textContent = m.name ?? m.id;
    row.onclick = async () => {
      const r = await cmd('model_set', { provider: m.provider, model: m.id });
      if (!r.success) addSys(`切换模型失败：${r.error ?? '未知'}`, true);
      else addSys(`已切换模型：${m.provider}/${m.id}`);
      await refreshModels();
    };
    box.appendChild(row);
  }
}
async function refreshModels() {
  const [st, list] = await Promise.all([cmd('model_status'), cmd('model_list')]);
  if (st.success) modelStatus = st.data;
  const providers = modelStatus?.providers ?? [];
  fillProviderSelect($('setup-provider'), providers);
  fillProviderSelect($('set-provider'), providers);
  const sel = $('set-provider');
  const p = providers.find((x) => x.id === sel.value);
  $('set-provider-auth').className = `pill ${p?.hasAuth ? 'ok' : 'err'}`;
  $('set-provider-auth').textContent = p ? (p.hasAuth ? '已配置' : '未配置') : '';
  renderModelPick($('setup-models'), list.data ?? []);
  renderModelPick($('set-models'), list.data ?? []);
  const lv = modelStatus?.thinkingLevel ?? 'medium';
  $('set-thinking').innerHTML = THINK_LEVELS.map((l) => `<option value="${l}"${l === lv ? ' selected' : ''}>${THINK_LABEL[l]}</option>`).join('');
  // Gate: no current model → setup card takes over the empty state
  const noModel = modelStatus?.current == null;
  $('setup-card')?.classList.toggle('hidden', sawMessage || !noModel);
  if (!sawMessage && noModel) $('empty-state')?.classList.add('hidden');
  else $('empty-state')?.classList.remove('hidden');
  updateChips();
}
function updateChips() {
  const cur = modelStatus?.current;
  $('model-chip').textContent = cur ? `${cur.name ?? cur.id} ▾` : '选择模型 ▾';
  $('thinking-chip').textContent = `推理 ${THINK_LABEL[modelStatus?.thinkingLevel ?? 'medium']} ▾`;
}
async function saveKey(providerSel, keyInput, msgEl) {
  const provider = $(providerSel).value;
  const key = $(keyInput).value.trim();
  if (!provider || !key) return;
  const r = await cmd('auth_set_key', { provider, key });
  $(keyInput).value = '';
  const msg = $(msgEl);
  if (!r.success) {
    msg.textContent = `保存失败：${r.error ?? '未知'}`;
    msg.className = 'setup-msg err';
  } else {
    msg.textContent = `已保存 ${provider} 的密钥`;
    msg.className = 'setup-msg ok';
  }
  await refreshModels();
}
$('setup-save-key').onclick = () => saveKey('setup-provider', 'setup-key', 'setup-msg');
$('set-save-key').onclick = () => saveKey('set-provider', 'set-key', 'set-model-msg');
$('set-clear-key').onclick = async () => {
  const provider = $('set-provider').value;
  if (!provider) return;
  const r = await cmd('auth_clear', { provider });
  const msg = $('set-model-msg');
  msg.textContent = r.success ? `已清除 ${provider} 的凭据` : `清除失败：${r.error ?? '未知'}`;
  msg.className = `setup-msg ${r.success ? 'ok' : 'err'}`;
  await refreshModels();
};
$('set-provider').onchange = refreshModels;
$('set-thinking').onchange = async () => {
  const r = await cmd('thinking_set', { level: $('set-thinking').value });
  if (!r.success) addSys(`设置推理强度失败：${r.error ?? '未知'}`, true);
  refreshState();
};
$('cp-add').onclick = async () => {
  const spec = {
    provider: $('cp-id').value.trim(),
    model: $('cp-model').value.trim(),
    baseUrl: $('cp-base').value.trim(),
    api: $('cp-api').value,
    apiKeyEnv: $('cp-keyenv').value.trim() || undefined,
  };
  const msg = $('cp-msg');
  if (!spec.provider || !spec.model || !spec.baseUrl) {
    msg.textContent = '提供方 ID、模型 ID、Base URL 都要填';
    msg.className = 'setup-msg err';
    return;
  }
  const r = await cmd('provider_add', spec);
  if (!r.success) {
    msg.textContent = `添加失败：${r.error ?? '未知'}`;
    msg.className = 'setup-msg err';
    return;
  }
  msg.textContent = `已添加 ${spec.provider}——现在给它存 API Key`;
  msg.className = 'setup-msg ok';
  await refreshModels();
  $('set-provider').value = spec.provider;
  $('set-key').focus();
};

/* ---------- workdir / settings ---------- */
async function refreshSettings() {
  const r = await cmd('supervisor_status');
  const s = r.data ?? {};
  $('set-workdir').textContent = s.workdir ?? '';
  $('set-instance').textContent = s.instanceRoot ?? '';
}
$('set-pick-dir').onclick = async () => {
  const res = await fetch('/api/pick-dir', { method: 'POST' }).then((r) => r.json()).catch(() => ({}));
  // No native picker (dev server): fall back to a manual path prompt.
  const dir = res?.dir ?? prompt('输入工作目录完整路径', $('set-workdir').textContent);
  if (!dir) return;
  const r = await cmd('set_workdir', { path: dir });
  if (!r.success) addSys(`切换工作目录失败：${r.error ?? '未知'}`, true);
  refreshSettings();
};

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

async function refreshBodies() {
  const r = await cmd('body_list');
  const grid = $('body-grid');
  grid.innerHTML = '';
  bodiesCache = r.data ?? [];

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

async function refreshState() {
  const r = await cmd('get_state');
  const s = r.data ?? {};
  if (s.session?.file) currentSessionFile = s.session.file;
  const name = s.session?.name;
  if (currentView === 'chat') $('view-title').textContent = name || '当前任务';
  await refreshModels();
  renderSessions();
}
function refreshAll() { refreshBodies(); refreshState(); refreshJobs(); refreshAudit(); refreshSessions(); refreshSettings(); }
function setStatus(t, kind) {
  $('status').textContent = t;
  $('status-dot').className = `dot${kind === 'err' ? ' err' : t === '就绪' ? ' on' : ''}`;
}

/* ---------- views ---------- */
const TITLES = { jobs: '任务', audit: '审计', bodies: '身体', settings: '设置' };
let currentView = 'chat';
function switchView(v) {
  currentView = v;
  for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('active', item.dataset.view === v);
  for (const sec of document.querySelectorAll('.view')) sec.classList.toggle('hidden', sec.id !== `view-${v}`);
  if (v === 'chat') $('view-title').textContent = sessionsCache.find((s) => s.path === currentSessionFile)?.name || '当前任务';
  else $('view-title').textContent = TITLES[v] ?? '';
  if (v === 'jobs') refreshJobs();
  if (v === 'audit') refreshAudit();
  if (v === 'bodies') refreshBodies();
  if (v === 'settings') { refreshSettings(); refreshModels(); }
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
(async () => {
  await refreshAll();
  await replayHistory(); // reopened app should show the persisted session, not blank
})();

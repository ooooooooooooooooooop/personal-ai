/* Personal AI app UI — plain DOM, zero build.
 * Talks to the local bridge: POST /cmd for commands, /events (SSE) for the
 * live record stream. The UI never knows which body is underneath. */
'use strict';

const $ = (id) => document.getElementById(id);

/* ---------- toasts — transient notices; the transcript stays the record ---------- */
let toastBox = null;
function toast(text, kind = 'info') {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.id = 'toast-box';
    document.body.appendChild(toastBox);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  t.onclick = () => t.remove();
  toastBox.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, 4200);
}

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
  paintMinimapThumb();
});

/* ---------- minimap: 每条消息一个刻度，点击跳转 ---------- */
const minimap = $('minimap');
let mmQueued = false;
function paintMinimapThumb() {
  const th = minimap?.querySelector('.mm-thumb');
  if (!th || minimap.classList.contains('hidden')) return;
  const H = transcript.scrollHeight, h = minimap.clientHeight;
  th.style.top = `${(transcript.scrollTop / H) * h}px`;
  th.style.height = `${Math.max(10, (transcript.clientHeight / H) * h)}px`;
}
function renderMinimap() {
  const H = transcript.scrollHeight;
  if (!minimap || !sawMessage || H <= transcript.clientHeight * 1.2) {
    minimap?.classList.add('hidden'); return;
  }
  minimap.classList.remove('hidden');
  const h = minimap.clientHeight;
  minimap.innerHTML = '<div class="mm-thumb"></div>';
  for (const m of transcript.querySelectorAll('.msg')) {
    const t = document.createElement('div');
    t.className = `mm-tick${m.classList.contains('user') ? ' user' : ''}`;
    t.style.top = `${(m.offsetTop / H) * h}px`;
    t.style.height = `${Math.max(2, (m.offsetHeight / H) * h)}px`;
    minimap.appendChild(t);
  }
  paintMinimapThumb();
}
function queueMinimap() {
  if (mmQueued) return;
  mmQueued = true;
  requestAnimationFrame(() => { mmQueued = false; renderMinimap(); });
}
new MutationObserver(queueMinimap).observe(transcript, { childList: true });
minimap?.addEventListener('pointerdown', (e) => {
  const r = minimap.getBoundingClientRect();
  transcript.scrollTop = ((e.clientY - r.top) / r.height) * transcript.scrollHeight - transcript.clientHeight / 2;
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
      const nl = seg.indexOf('\n');
      const lang = (nl === -1 ? seg : seg.slice(0, nl)).trim().toLowerCase();
      const code = nl === -1 ? '' : seg.slice(nl + 1);
      if (lang === 'diff') {
        const rows = code.split('\n').map((l) => {
          const cls = l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : /^@@|^\s*$/.test(l) ? 'd-hunk' : '';
          return `<span class="${cls}">${escHtml(l)}</span>`;
        }).join('\n');
        return `<pre class="diff"><button class="code-copy">复制</button><code>${rows}</code></pre>`;
      }
      const langTag = lang ? `<span class="code-lang">${escHtml(lang)}</span>` : '';
      return `<pre><button class="code-copy">复制</button>${langTag}<code>${escHtml(code)}</code></pre>`;
    }
    const lines = seg.split('\n');
    let html = '';
    let list = null;
    let table = null;
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    const closeTable = () => { if (table) { html += '</tbody></table>'; table = null; } };
    const closeAll = () => { closeList(); closeTable(); };
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let m;
      // markdown table: | a | b | header row + |---| separator row
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[li + 1] ?? '') && !table) {
        closeList();
        const cells = line.split('|').slice(1, -1).map((c) => c.trim());
        html += `<table><thead><tr>${cells.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>`;
        table = true;
        li++; // skip separator row
        continue;
      }
      if (table) {
        if (/^\s*\|.*\|\s*$/.test(line)) {
          const cells = line.split('|').slice(1, -1).map((c) => c.trim());
          html += `<tr>${cells.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`;
          continue;
        }
        closeTable();
      }
      if ((m = line.match(/^\s*[-*]\s+(.+)/))) {
        closeTable();
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += `<li>${inlineMd(m[1])}</li>`;
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.+)/))) {
        closeTable();
        if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
        html += `<li>${inlineMd(m[1])}</li>`;
      } else if ((m = line.match(/^#{1,4}\s+(.+)/))) {
        closeAll(); html += `<div class="md-h">${inlineMd(m[1])}</div>`;
      } else if ((m = line.match(/^>\s?(.*)/))) {
        closeAll(); html += `<blockquote>${inlineMd(m[1])}</blockquote>`;
      } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
        closeAll(); html += '<hr>';
      } else {
        closeAll(); html += `${inlineMd(line)}\n`;
      }
    }
    closeAll();
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
  actGroup = null; // a text message breaks any running tool group
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.innerHTML = '<div class="bubble"></div><div class="msg-actions"></div>';
  const b = div.querySelector('.bubble');
  if (who === 'user') b.textContent = text; else b.innerHTML = md(text);
  const bar = div.querySelector('.msg-actions');
  const mkBtn = (label, title, fn) => {
    const btn = document.createElement('button');
    btn.className = 'ma-btn';
    btn.textContent = label;
    btn.title = title;
    btn.onclick = fn;
    bar.appendChild(btn);
    return btn;
  };
  mkBtn('复制', '复制内容', () => {
    navigator.clipboard?.writeText(b.textContent ?? '').then(() => {
      const t = bar.querySelector('.ma-btn');
      t.textContent = '已复制'; setTimeout(() => { t.textContent = '复制'; }, 1200);
    });
  });
  if (who === 'user') {
    mkBtn('重发', '重新发送这条消息', async () => {
      lastUserText = b.textContent ?? '';
      const r = await cmd('prompt', { message: b.textContent ?? '' });
      if (!r.success) addSys(`重发失败：${r.error ?? '未知'}`, true);
    });
    // 编辑重发：回退到这条提问点，原文进输入框改完再发（rewind 给 editorText）
    mkBtn('编辑', '回退到这条并编辑重发', async () => {
      const r = await cmd('session_entries');
      const myText = b.textContent ?? '';
      const entry = [...(r.data ?? [])].reverse()
        .find((e) => (e.text ?? '').slice(0, 80) === myText.slice(0, 80));
      if (!entry) { addSys('找不到这条消息对应的回退点', true); return; }
      const r2 = await cmd('session_rewind', { entryId: entry.entryId });
      if (!r2.success) { addSys(`回退失败：${r2.error ?? '未知'}`, true); return; }
      input.value = r2.data?.editorText ?? myText;
      autogrow(); input.focus();
      await replayHistory(); refreshState();
    });
  } else {
    mkBtn('重新生成', '重新回答上一条', async () => {
      if (!lastUserText) return;
      const r = await cmd('prompt', { message: lastUserText });
      if (!r.success) addSys(`重新生成失败：${r.error ?? '未知'}`, true);
    });
  }
  transcript.appendChild(div);
  scrollTail();
  return div;
}
function addThinking(text) {
  noteMessage();
  actGroup = null;
  const div = document.createElement('div');
  div.className = 'think-row';
  div.innerHTML = `<button class="think-head"><span class="t-caret">${CARET}</span><span class="t-icon">${THINK_ICON}</span>思考过程</button><div class="think-body"></div>`;
  div.querySelector('.think-body').textContent = text;
  div.querySelector('.think-head').onclick = () => div.classList.toggle('open');
  transcript.appendChild(div);
  return div;
}
/* Collapsible pre-formatted block — /diff output, /btw answers. Reuses the
   think-row collapse pattern but renders monospace payload. */
function addDiffBlock(title, badge, text) {
  noteMessage();
  actGroup = null;
  const div = document.createElement('div');
  div.className = 'think-row diff-row open';
  div.innerHTML = `<button class="think-head"><span class="t-caret">${CARET}</span><span class="op-badge op-${badge === 'btw' ? 'create' : badge}">${badge}</span> <span class="diff-title"></span></button><pre class="diff-body"></pre>`;
  div.querySelector('.diff-title').textContent = title;
  div.querySelector('.diff-body').textContent = text;
  div.querySelector('.think-head').onclick = () => div.classList.toggle('open');
  transcript.appendChild(div);
  scrollTail();
  return div;
}
function addSys(text, bad = false) {
  noteMessage();
  actGroup = null;
  const div = document.createElement('div');
  div.className = `sys${bad ? ' bad' : ''}`;
  div.textContent = text;
  transcript.appendChild(div);
  scrollTail();
  if (bad) toast(text, 'err'); // errors surface as toasts too — transcript keeps the record
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
let actGroup = null; // .act-group element collecting consecutive tool rows

/* tool verb + icon by name — mirrors the action-categorization idea */
const TOOL_KINDS = [
  [/^(read|cat|view)/i, { verb: '读取', icon: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 9h6M9 13h6M9 17h4"/>' }],
  [/^(edit|write|patch|apply)/i, { verb: '改写', icon: '<path d="M17 3l4 4L8 20l-5 1 1-5z"/>' }],
  [/^(bash|shell|powershell|cmd|run|exec)/i, { verb: '运行', icon: '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>' }],
  [/^(grep|search|find|ls|list|glob)/i, { verb: '检索', icon: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>' }],
  [/^(fetch|web|http|browse)/i, { verb: '获取', icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>' }],
  [/^(delegate|task|spawn)/i, { verb: '委派', icon: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M6 8.5V12l6 3.5L18 12V8.5"/>' }],
  [/^(job|audit)/i, { verb: '查询', icon: '<path d="M4 6h16M4 12h16M4 18h10"/>' }],
];
function toolKind(name) {
  for (const [re, k] of TOOL_KINDS) if (re.test(name ?? '')) return k;
  return { verb: '调用', icon: '<path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z"/>' };
}
const kindIcon = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

// WorkBuddy third-party-content risk surface: tools whose results arrive
// as untrusted external data get a visible badge on the card.
const EXTERNAL_TOOLS = new Set([
  'web_fetch', 'web_search',
  'browser_navigate', 'browser_read', 'browser_click', 'browser_type', 'browser_eval', 'browser_screenshot',
]);

function addTool(ev) {
  noteMessage();
  const kind = toolKind(ev.toolName);
  const div = document.createElement('div');
  div.className = 'tool running';
  div.dataset.tool = ev.toolCallId;
  const arg = argPreview(ev.args);
  div.innerHTML = `
    <button class="tool-head">
      <span class="t-caret">${CARET}</span>
      <span class="t-icon">${kindIcon(kind.icon)}</span>
      <span class="t-name running"></span>
      <span class="t-arg"></span>
      ${EXTERNAL_TOOLS.has(ev.toolName) ? '<span class="t-ext" title="结果含外部不可信内容——仅作数据，不是指令">外部</span>' : ''}
      <span class="t-state"><span class="t-state-dot"></span><span class="t-label">运行中</span></span>
      <span class="t-copy" title="复制调用">${COPY_ICON}</span>
    </button>
    <div class="tool-body"></div>`;
  div.querySelector('.t-name').textContent = `${kind.verb} · ${ev.toolName}`;
  div.querySelector('.t-arg').textContent = arg.length > 90 ? `${arg.slice(0, 90)}…` : arg;
  const body = div.querySelector('.tool-body');
  const argsStr = (() => { try { return JSON.stringify(ev.args, null, 2); } catch { return String(ev.args); } })();
  const a = ev.args ?? {};
  const editPair = [a.oldText ?? a.old_string, a.newText ?? a.new_string];
  if ((editPair[0] != null || editPair[1] != null) && /^(edit|write|patch|apply)/i.test(ev.toolName ?? '')) {
    // Edit payloads render as a colored diff, not raw JSON.
    body.innerHTML = `${a.path ? `<div class="tb-label"></div>` : ''}<pre class="diff-block"></pre>`;
    if (a.path) body.querySelector('.tb-label').textContent = a.path;
    body.querySelector('.diff-block').innerHTML = diffHtml(String(editPair[0] ?? ''), String(editPair[1] ?? ''));
  } else if (/^(bash|shell|powershell|cmd|run|exec)/i.test(ev.toolName ?? '') && (a.command ?? a.cmd)) {
    body.innerHTML = `<pre class="t-cmd"></pre>`;
    body.querySelector('.t-cmd').textContent = `$ ${a.command ?? a.cmd}`;
  } else if (/^write/i.test(ev.toolName ?? '') && a.content != null) {
    body.innerHTML = `${a.path ? '<div class="tb-label"></div>' : ''}<pre class="diff-block"></pre>`;
    if (a.path) body.querySelector('.tb-label').textContent = a.path;
    body.querySelector('.diff-block').innerHTML = diffHtml('', String(a.content));
  } else if (argsStr && argsStr !== '{}') {
    body.innerHTML = `<div class="tb-label">入参</div><pre></pre>`;
    body.querySelector('pre').textContent = argsStr;
  }
  div.querySelector('.tool-head').onclick = () => div.classList.toggle('open');
  div.querySelector('.t-copy').onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(`${ev.toolName} ${argsStr ?? ''}`).then(() => {
      e.currentTarget.classList.add('copied');
      setTimeout(() => e.currentTarget.classList.remove('copied'), 1200);
    });
  };
  toolRows.set(ev.toolCallId, div);

  // Consecutive tool rows fold into an activity group — "N 个步骤".
  const last = transcript.lastElementChild;
  if (actGroup && last === actGroup) {
    actGroup.querySelector('.act-items').appendChild(div);
  } else if (last?.classList?.contains('tool')) {
    const g = document.createElement('div');
    g.className = 'act-group open';
    g.innerHTML = `<button class="act-head"><span class="t-caret">${CARET}</span><span class="act-count"></span></button><div class="act-items"></div>`;
    g.querySelector('.act-head').onclick = () => g.classList.toggle('open');
    transcript.replaceChild(g, last);
    g.querySelector('.act-items').appendChild(last);
    g.querySelector('.act-items').appendChild(div);
    actGroup = g;
  } else {
    transcript.appendChild(div);
    actGroup = null;
  }
  if (actGroup) {
    const n = actGroup.querySelectorAll('.act-items .tool').length;
    actGroup.querySelector('.act-count').textContent = `${n} 个步骤`;
  }
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
  // browser_screenshot → inline preview (Trae browser-preview analogue);
  // served through /api/artifact, which only exposes <instance>/exports/**
  if (ev.toolName === 'browser_screenshot' && !ev.isError) {
    const m = out.match(/screenshot saved: (.+)/);
    if (m) {
      const src = `/api/artifact?path=${encodeURIComponent(m[1].trim())}`;
      el.querySelector('.tool-body').insertAdjacentHTML('beforeend',
        `<a href="${src}" target="_blank" rel="noopener"><img class="shot-preview" src="${src}" alt="browser screenshot" /></a>`);
    }
  }
  toolRows.delete(ev.toolCallId);
  scrollTail();
}
/* Minimal line diff for approval cards / edit tool payloads — shared head and
   tail render as dim context, changed middle as - old / + new. */
function diffHtml(oldStr, newStr) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const a = String(oldStr).split('\n'), b = String(newStr).split('\n');
  let i = 0, j = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const out = [];
  const ctx = (arr, from, to) => { for (let k = from; k < to; k++) out.push(`<span class="d-ctx">  ${esc(arr[k])}</span>`); };
  if (i > 0) { ctx(a, 0, Math.min(i, 3)); if (i > 3) out.push('<span class="d-ctx">  ⋯</span>'); }
  for (let k = i; k < a.length - j; k++) out.push(`<span class="d-del">- ${esc(a[k])}</span>`);
  for (let k = i; k < b.length - j; k++) out.push(`<span class="d-add">+ ${esc(b[k])}</span>`);
  if (j > 0) { if (j > 3) out.push('<span class="d-ctx">  ⋯</span>'); ctx(a, Math.max(i, a.length - Math.min(j, 3)), a.length); }
  return out.join('\n');
}
function messageText(m) {
  const blocks = m?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
}
function thinkingText(m) {
  const blocks = m?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b?.type === 'thinking').map((b) => b.thinking ?? b.text ?? '').join('');
}

/* ---------- live todo checklist (update_todos tool) ---------- */
function renderTodos(todos) {
  const panel = $('todo-panel');
  if (!panel) return;
  if (!Array.isArray(todos) || todos.length === 0) { panel.classList.add('hidden'); return; }
  const done = todos.filter((t) => t.status === 'completed').length;
  panel.classList.remove('hidden');
  panel.innerHTML = `<button class="todo-head"><span class="t-caret">${CARET}</span>任务清单 · ${done}/${todos.length}</button><div class="todo-items"></div>`;
  const items = panel.querySelector('.todo-items');
  for (const t of todos) {
    const row = document.createElement('div');
    row.className = `todo-item ${t.status === 'in_progress' ? 'doing' : t.status === 'completed' ? 'done' : ''}`;
    row.innerHTML = `<span class="todo-box">${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◧' : '☐'}</span><span class="todo-text"></span>`;
    row.querySelector('.todo-text').textContent = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    items.appendChild(row);
  }
  panel.querySelector('.todo-head').onclick = () => panel.classList.toggle('fold');
}
async function refreshTodos() {
  const r = await cmd('todos_list');
  if (r.success) renderTodos(r.data);
}

/* ---------- processing row: "处理中 · Ns" between turns ---------- */
let procEl = null;
let procTimer = null;
let procStart = 0;
function startProc() {
  stopProc();
  procStart = Date.now();
  procEl = document.createElement('div');
  procEl.className = 'proc-row';
  procEl.innerHTML = '<span class="proc-dot"></span><span class="proc-text">处理中 · 0s</span>';
  transcript.appendChild(procEl);
  scrollTail();
  procTimer = setInterval(() => {
    const t = procEl?.querySelector('.proc-text');
    if (t) t.textContent = `处理中 · ${Math.round((Date.now() - procStart) / 1000)}s`;
  }, 1000);
}
function stopProc(final = false) {
  clearInterval(procTimer);
  procTimer = null;
  if (procEl && final) {
    const s = Math.round((Date.now() - procStart) / 1000);
    procEl.querySelector('.proc-text').textContent = `已处理 ${s}s`;
    procEl.classList.add('done');
    procEl = null;
    return;
  }
  procEl?.remove();
  procEl = null;
}

/* ---------- governance ask cards (operator-in-the-loop) ---------- */
const askCards = new Map(); // askId -> card element
let askTick = null;
const ANSWER_LABEL = {
  allow: '已允许', allow_session: '本会话已允许', always: '总是允许',
  deny: '已拒绝', timeout: '超时未答 · 已拒绝', aborted: '已中止',
};

function ensureAskTick() {
  if (askTick) return;
  askTick = setInterval(() => {
    if (!askCards.size) { clearInterval(askTick); askTick = null; return; }
    for (const el of askCards.values()) {
      const t = el.querySelector('.ask-timer');
      const left = Math.max(0, Math.ceil((Number(el.dataset.exp) - Date.now()) / 1000));
      if (t) t.textContent = `剩余 ${left}s`;
    }
  }, 1000);
}

function addAskCard(ask) {
  if (!ask?.id || askCards.has(ask.id)) return;
  noteMessage();
  actGroup = null; // an approval gate breaks any running tool group
  const kind = toolKind(ask.toolName);
  const div = document.createElement('div');
  div.className = 'ask-card';
  div.dataset.exp = ask.expiresAt ?? 0;
  div.dataset.kind = ask.kind ?? 'approval';
  div.innerHTML = `
    <div class="ask-head">
      <span class="t-icon">${kindIcon(kind.icon)}</span>
      <span class="ask-title">需要你的批准</span>
      <span class="ask-tool"></span>
      <span class="ask-risk"></span>
      <span class="ask-timer"></span>
    </div>
    <pre class="ask-summary"></pre>
    <div class="ask-detail"></div>
    <div class="ask-foot">
      <button class="ask-btn primary" data-a="allow">允许一次</button>
      <button class="ask-btn" data-a="allow_session">本会话允许</button>
      <button class="ask-btn" data-a="always">总是允许</button>
      <button class="ask-btn danger" data-a="deny">拒绝</button>
    </div>`;
  div.querySelector('.ask-tool').textContent = `${kind.verb} · ${ask.toolName}`;
  // SecurityAnalyzer-style risk line: WHICH class and WHICH units earned it
  if (ask.risk?.class) {
    const units = (ask.risk.units ?? []).slice(0, 3).join(' | ');
    div.querySelector('.ask-risk').textContent = `风险·${ask.risk.class}${units ? `：${units.slice(0, 120)}` : ''}`;
  } else div.querySelector('.ask-risk').remove();
  div.querySelector('.ask-summary').textContent = ask.summary || '（无详情）';
  if (ask.detail) div.querySelector('.ask-detail').textContent = ask.detail;
  else div.querySelector('.ask-detail').remove();
  // The operator approves what they can see — render the real payload, not
  // just a one-line summary. Command → mono block; write/edit → content or
  // old→new diff; delete → path + consequence.
  const payload = div.querySelector('.ask-detail') ?? div.insertBefore(document.createElement('div'), div.querySelector('.ask-foot'));
  if (payload.classList?.contains('ask-detail') === false) payload.className = 'ask-detail';
  if (ask.argsTruncated) {
    // WYSIWYG guard: never silently clip — tell the operator the approval
    // covers a payload larger than what is shown. "总是允许" is withheld:
    // a durable grant cannot be made over a clipped payload.
    div.querySelector('[data-a="always"]')?.remove();
    payload.insertAdjacentHTML('beforeend',
      `<div class="ask-trunc">载荷过长，仅显示截断前缀（完整参数 ${ask.argsTotalChars ?? '?'} 字符）——批准/拒绝作用于完整参数</div>`);
  }
  if (ask.args && typeof ask.args === 'object') {
    const cmdStr = ask.args.command ?? ask.args.cmd;
    const editPair = [ask.args.oldText ?? ask.args.old_string, ask.args.newText ?? ask.args.new_string];
    if (cmdStr) {
      payload.insertAdjacentHTML('beforeend', `<pre class="ask-cmd"></pre>`);
      payload.querySelector('.ask-cmd').textContent = `$ ${cmdStr}`;
    } else if (editPair[0] != null || editPair[1] != null) {
      payload.insertAdjacentHTML('beforeend', `<div class="ask-path"></div><pre class="diff-block"></pre>`);
      if (ask.args.path) payload.querySelector('.ask-path').textContent = ask.args.path;
      payload.querySelector('.diff-block').innerHTML = diffHtml(String(editPair[0] ?? ''), String(editPair[1] ?? ''));
    } else if (ask.args.path && ask.args.content != null) {
      payload.insertAdjacentHTML('beforeend', `<div class="ask-path"></div><pre class="ask-cmd"></pre>`);
      payload.querySelector('.ask-path').textContent = ask.args.path;
      payload.querySelector('.ask-cmd').textContent = String(ask.args.content);
    } else if (ask.args.path) {
      payload.insertAdjacentHTML('beforeend', `<pre class="ask-cmd"></pre>`);
      payload.querySelector('.ask-cmd').textContent = `${ask.toolName === 'delete' ? '删除（移入回收站，可经 fileops 回执恢复）' : ask.toolName}：${ask.args.path}`;
    }
  }
  // Structured question card (ask_user): option buttons + free text replace
  // the approval buttons — the answer is the operator's words, not a verdict.
  if (ask.kind === 'question') {
    div.querySelector('.ask-title').textContent = '需要你的回答';
    const foot = div.querySelector('.ask-foot');
    foot.innerHTML = '';
    foot.classList.add('ask-question');
    const submit = async (answer) => {
      foot.querySelectorAll('button,input').forEach((x) => { x.disabled = true; });
      const r = await cmd('decision_resolve', { askId: ask.id, answer });
      if (!r.success) {
        foot.querySelectorAll('button,input').forEach((x) => { x.disabled = false; });
        addSys(`回答提交失败：${r.error ?? '未知'}`, true);
      }
    };
    for (const o of ask.options ?? []) {
      const b = document.createElement('button');
      b.className = 'ask-btn';
      b.textContent = o.label;
      if (o.description) b.title = o.description;
      b.onclick = () => submit(o.label);
      foot.appendChild(b);
    }
    const input = document.createElement('input');
    input.className = 'ask-free';
    input.placeholder = '或直接输入回答…';
    input.onkeydown = (e) => { if (e.key === 'Enter' && input.value.trim()) submit(input.value.trim()); };
    const send = document.createElement('button');
    send.className = 'ask-btn primary';
    send.textContent = '回答';
    send.onclick = () => { if (input.value.trim()) submit(input.value.trim()); };
    foot.appendChild(input);
    foot.appendChild(send);
  } else {
  div.querySelectorAll('.ask-btn').forEach((b) => {
    b.onclick = async () => {
      div.querySelectorAll('.ask-btn').forEach((x) => { x.disabled = true; });
      const r = await cmd('decision_resolve', { askId: ask.id, answer: b.dataset.a });
      if (!r.success) {
        div.querySelectorAll('.ask-btn').forEach((x) => { x.disabled = false; });
        addSys(`批准提交失败：${r.error ?? '未知'}`, true);
      }
    };
  });
  }
  askCards.set(ask.id, div);
  transcript.appendChild(div);
  ensureAskTick();
  scrollTail();
}

function markAskResolved(askId, answer) {
  const el = askCards.get(askId);
  if (!el) return;
  askCards.delete(askId);
  el.classList.add('resolved', `a-${answer}`);
  el.querySelector('.ask-foot')?.remove();
  el.querySelector('.ask-timer')?.remove();
  const tag = document.createElement('span');
  tag.className = `ask-verdict ${answer === 'deny' || answer === 'timeout' ? 'no' : 'yes'}`;
  tag.textContent = ANSWER_LABEL[answer]
    ?? (answer === 'aborted' ? '已中止'
      : (el.dataset.kind === 'question' ? `已回答：${String(answer).slice(0, 80)}` : String(answer)));
  el.querySelector('.ask-head').appendChild(tag);
}

/* asks raised before a UI reload/reconnect are still live — re-render them */
async function refreshPending() {
  const r = await cmd('pending_list');
  if (!r.success) return;
  for (const ask of r.data ?? []) addAskCard(ask);
}

/* ---------- history replay (session switch / restart) ---------- */
/* ---------- history pagination (PI-Desktop long-session analogue) ----------
   session_history returns the full fold; we render the newest page and keep
   the rest in a backlog — "加载更早" mounts older chunks on demand so a
   500-message session doesn't stamp 500 nodes at once. */
const HISTORY_PAGE = 50;
let historyBacklog = [];

function renderHistoryMsg(m) {
  if (m.role === 'user') { lastUserText = m.text ?? ''; addMsg('user', m.text ?? ''); }
  else if (m.role === 'assistant') {
    if (m.thinking) addThinking(m.thinking);
    if (m.text) addMsg('assistant', m.text);
    for (const t of m.tools ?? []) addSys(`调用工具 ${t}`);
    if (m.error) addSys(`模型错误：${m.error}`, true);
  } else if (m.role === 'toolResult' || m.role === 'tool_result') {
    // Replayed tool results render as completed tool rows with output.
    const kind = toolKind(m.toolName);
    const div = document.createElement('div');
    div.className = 'tool done';
    div.innerHTML = `
      <button class="tool-head">
        <span class="t-caret">${CARET}</span>
        <span class="t-icon">${kindIcon(kind.icon)}</span>
        <span class="t-name"></span>
        <span class="t-arg"></span>
        <span class="t-state"><span class="t-state-dot"></span><span class="t-label">完成</span></span>
      </button>
      <div class="tool-body"><div class="tb-label">输出</div><pre></pre></div>`;
    div.querySelector('.t-name').textContent = `${kind.verb} · ${m.toolName ?? 'tool'}`;
    const out = (m.text ?? '');
    div.querySelector('.tool-body pre').textContent = out.length > 6000 ? `${out.slice(0, 6000)}\n…（截断）` : out;
    div.querySelector('.tool-head').onclick = () => div.classList.toggle('open');
    transcript.appendChild(div);
    noteMessage();
  }
}

function mountOlderButton() {
  const btn = document.createElement('button');
  btn.className = 'sys older-btn';
  btn.id = 'older-btn';
  const label = () => `加载更早的消息（还有 ${historyBacklog.length} 条）`;
  btn.textContent = label();
  btn.onclick = () => {
    const chunk = historyBacklog.splice(-HISTORY_PAGE);
    const before = transcript.children.length;
    for (const m of chunk) renderHistoryMsg(m); // appends at bottom…
    // …then move the freshly-rendered nodes up, right after the button.
    // children[i] tracks correctly: each move shifts the next appended node
    // into the following slot, so i++ walks exactly the new chunk.
    const ref = btn.nextSibling;
    const count = transcript.children.length - before;
    for (let i = before; i < before + count; i++) transcript.insertBefore(transcript.children[i], ref);
    if (historyBacklog.length) btn.textContent = label();
    else btn.remove();
  };
  transcript.prepend(btn);
}

async function replayHistory() {
  clearTranscript();
  sessionCost = 0;
  historyBacklog = [];
  const r = await cmd('session_history');
  const msgs = r.data ?? [];
  // cost accounting covers the WHOLE session, not just the rendered page
  for (const m of msgs) if (m.usage?.cost?.total) sessionCost += Number(m.usage.cost.total);
  historyBacklog = msgs.slice(0, Math.max(0, msgs.length - HISTORY_PAGE));
  for (const m of msgs.slice(-HISTORY_PAGE)) renderHistoryMsg(m);
  if (historyBacklog.length) mountOlderButton();
  if (!sawMessage && modelStatus?.current == null) $('setup-card')?.classList.remove('hidden');
}

/* ---------- agent events ---------- */
let thinkEl = null; // live thinking row being streamed into
let lastUserText = ''; // for regenerate

/* notification drawer — bounded log behind the bell */
const notifyLog = [];
let unreadNotify = 0;
function paintBell() {
  const bell = $('bell');
  if (!bell) return;
  bell.classList.toggle('hidden', !notifyLog.length);
  const c = $('bell-count');
  c.classList.toggle('hidden', !unreadNotify);
  c.textContent = unreadNotify > 9 ? '9+' : String(unreadNotify);
}
$('bell') && ($('bell').onclick = () => {
  const d = $('bell-drawer');
  if (d.classList.toggle('hidden')) return; // just closed — nothing to paint
  unreadNotify = 0;
  paintBell();
  d.innerHTML = notifyLog.length
    ? notifyLog.map((n) => `<div class="bell-row ${n.level === 'err' ? 'err' : ''}"><span class="bell-time"></span><span class="bell-msg"></span></div>`).join('')
    : '<div class="dim" style="padding:12px">暂无通知</div>';
  d.querySelectorAll('.bell-row').forEach((row, i) => {
    const n = notifyLog[i];
    row.querySelector('.bell-time').textContent = new Date(n.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    row.querySelector('.bell-msg').textContent = n.message;
  });
});
document.addEventListener('click', (e) => {
  const d = $('bell-drawer');
  if (d && !d.classList.contains('hidden') && !d.contains(e.target) && e.target.id !== 'bell' && !$('bell').contains(e.target)) d.classList.add('hidden');
});

function onAgentEvent(ev) {
  switch (ev?.type) {
    case 'agent_start':
      setBusy(true);
      assistantEl = null;
      thinkEl = null;
      startProc();
      break;
    case 'message_start':
      if (ev.message?.role === 'assistant') assistantEl = addMsg('assistant', '');
      break;
    case 'message_update': {
      const think = thinkingText(ev.message);
      if (think) {
        if (!thinkEl) thinkEl = addThinking('');
        thinkEl.querySelector('.think-body').textContent = think;
        scrollTail();
      }
      const text = messageText(ev.message);
      if (text) {
        (assistantEl ??= addMsg('assistant', '')).querySelector('.bubble').innerHTML = md(text);
        scrollTail();
      }
      break;
    }
    case 'message_end': {
      const m = ev.message;
      if (m?.role === 'assistant') {
        attachMeta(assistantEl, m);
        if (m.usage?.cost?.total) { sessionCost += Number(m.usage.cost.total); updateUsageChip(); }
        if (m.errorMessage) addSys(`模型错误：${m.errorMessage}`, true);
      }
      break;
    }
    case 'notify': {
      // notify_user: model→operator one-way notification (Kimi NotifyUser)
      toast(ev.message, ev.level === 'err' ? 'err' : 'info');
      addSys(`通知：${ev.message}`, ev.level === 'err');
      // notification drawer (PI-Desktop notification center analogue):
      // toasts are transient — this keeps the last 50 for recall
      notifyLog.unshift({ message: ev.message, level: ev.level ?? 'info', at: Date.now() });
      if (notifyLog.length > 50) notifyLog.pop();
      unreadNotify += 1;
      paintBell();
      break;
    }
    case 'jobs_changed':
      if (currentView === 'jobs') refreshJobs();
      break;
    case 'verify_result':
      // Aider-style post-write verifier — failures already reflect into the
      // model's context via the observation stream; this is the operator's copy
      addSys(ev.ok ? `验证通过：${ev.command}` : `验证失败：${ev.command}（失败输出已回注上下文）`, !ev.ok);
      break;
    case 'projection':
      lastProjection = ev.projection ?? null;
      paintGoalLine();
      break;
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
      if (ev.toolName === 'update_todos' && !ev.isError) refreshTodos();
      // file mutations land in the changes view's receipt stream
      if (!ev.isError && ['write', 'edit', 'delete'].includes(ev.toolName) && currentView === 'changes') refreshChanges();
      break;
    case 'governance_ask':
      addAskCard(ev.ask);
      break;
    case 'governance_resolved':
      markAskResolved(ev.askId, ev.answer);
      break;
    case 'compaction_start': {
      noteMessage();
      actGroup = null;
      const div = document.createElement('div');
      div.className = 'sys compact-row pending';
      div.dataset.compact = '1';
      div.textContent = `压缩上下文中…（${{ manual: '手动', threshold: '阈值', overflow: '溢出' }[ev.reason] ?? ev.reason}）`;
      transcript.appendChild(div);
      scrollTail();
      break;
    }
    case 'compaction_end': {
      const row = transcript.querySelector('.compact-row.pending');
      const text = ev.aborted ? '压缩已中止'
        : ev.errorMessage ? `压缩失败：${ev.errorMessage}`
        : '上下文已压缩';
      if (row) { row.textContent = text; row.classList.remove('pending'); row.classList.toggle('bad', Boolean(ev.errorMessage)); }
      else addSys(text, Boolean(ev.errorMessage));
      refreshState(); // contextUsage drops after compaction
      break;
    }
    case 'auto_retry_start':
      setStatus(`重试中 ${ev.attempt}/${ev.maxAttempts}…`, 'err');
      break;
    case 'auto_retry_end':
      setStatus(ev.success ? '运行中…' : '重试失败', ev.success ? '' : 'err');
      if (!ev.success && ev.finalError) addSys(`自动重试失败：${ev.finalError}`, true);
      break;
    case 'session_info_changed':
      refreshSessions();
      refreshState();
      break;
    case 'budget_warning':
      addSys(`预算已用 ${ev.pct}%——接近上限，建议收敛任务或继续前确认`, true);
      break;
    case 'budget_exceeded':
      addSys(`预算超限——会话已停止：${ev.rule} ${ev.consumed} ≥ ${ev.limit}（上限来自规范策略/操作员环境，模型不能自行放宽）`, true);
      toast('预算超限，运行已中止');
      setStatus('预算超限', 'err');
      refreshState();
      break;
    case 'budget_error':
      addSys(`预算记账失败：${ev.error}——已配限时这是治理事件`, true);
      break;
    case 'thinking_level_changed':
      refreshState();
      break;
    case 'session_changed':
      currentSessionFile = ev.session?.file ?? null;
      sessionCost = 0;
      loadDraft();
      replayHistory();
      refreshSessions();
      refreshPending();
      refreshState();
      refreshMode(); // plan/act is session-scoped — chip must follow the switch
      refreshTodos();
      break;
    case 'agent_end':
      setBusy(false);
      assistantEl = null;
      thinkEl = null;
      stopProc(true);
      actGroup?.classList.remove('open');
      actGroup = null;
      refreshState();
      refreshSessionsSoon();
      flushQueue();
      break;
  }
}

/* meta chips under finished assistant messages: model + tokens + cost */
function attachMeta(el, m) {
  if (!el || el.querySelector('.msg-meta')) return;
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const parts = [];
  const prov = m.provider ?? m.model?.provider;
  const mid = m.responseModel ?? m.model?.id ?? m.model;
  if (prov || mid) parts.push(`<span class="meta-chip">${escHtml([prov, mid].filter(Boolean).join('/'))}</span>`);
  const u = m.usage;
  if (u?.totalTokens) {
    parts.push(`<span class="meta-chip">${u.input ?? 0}→${u.output ?? 0} tok</span>`);
    if (u.cost?.total) parts.push(`<span class="meta-chip">$${Number(u.cost.total).toFixed(4)}</span>`);
  }
  if (m.stopReason && !['stop', 'end_turn', 'toolUse', 'tool_use'].includes(m.stopReason)) {
    parts.push(`<span class="meta-chip warn">${escHtml(m.stopReason)}</span>`);
  }
  meta.innerHTML = parts.join('');
  el.appendChild(meta);
}

function setBusy(v) {
  busy = v;
  $('send').classList.toggle('hidden', v);
  $('abort').classList.toggle('hidden', !v);
  $('steer').disabled = !v;
  setStatus(v ? '运行中…' : '就绪');
}

/* ---------- usage chip: context window fill + session cost ---------- */
let sessionCost = 0;      // accumulated $ over this session's assistant messages
let lastCtxUsage = null;  // last contextUsage snapshot from get_state
let state = null;         // last get_state payload (+stats) — statusline source
function updateUsageChip() {
  const el = $('usage-chip');
  const parts = [];
  if (lastCtxUsage?.tokens != null) {
    const k = (lastCtxUsage.tokens / 1000).toFixed(1);
    const w = lastCtxUsage.contextWindow ? `${Math.round(lastCtxUsage.contextWindow / 1000)}k` : null;
    parts.push(`⛁ ${k}k${w ? `/${w}` : ''}${lastCtxUsage.percent != null ? ` ${Math.round(lastCtxUsage.percent)}%` : ''}`);
  }
  // getSessionStats totals cover compacted-away history — prefer them over
  // the replay-side accumulation whenever the body reports them.
  const st = state.stats;
  const cost = st?.cost ?? sessionCost;
  if (cost > 0) parts.push(`$${cost.toFixed(4)}`);
  el.textContent = parts.join(' · ');
  el.title = (lastCtxUsage?.tokens != null
    ? `上下文 ${lastCtxUsage.tokens?.toLocaleString?.()}/${lastCtxUsage.contextWindow?.toLocaleString?.()} tok` : '')
    + (st ? `；会话累计 ${st.tokens?.total?.toLocaleString?.() ?? '?'} tok（缓存读 ${st.tokens?.cacheRead?.toLocaleString?.() ?? 0}）· ${st.totalMessages ?? '?'} 条 · $${(st.cost ?? 0).toFixed(4)}` : '');
  el.classList.toggle('hidden', !parts.length);
}

/* ---------- ctx breakdown: click usage chip → estimated composition ---------- */
// Honest estimate: chars→tokens by script density (CJK ≈1.4 chars/tok,
// latin ≈4) per category, scaled so the sum equals the body's reported
// contextUsage.tokens. Labelled estimate — never a fake exact meter.
const estTok = (s) => {
  if (!s) return 0;
  let cjk = 0, other = 0;
  for (const ch of String(s)) (ch.codePointAt(0) > 0x2E7F ? cjk++ : other++);
  return cjk / 1.4 + other / 4;
};
async function showCtxBreakdown() {
  const r = await cmd('session_history');
  if (!r.success) { toast('拉取历史失败'); return; }
  const cat = { user: 0, assistant: 0, thinking: 0, tool: 0 };
  for (const m of r.data ?? []) {
    if (m.role === 'user') cat.user += estTok(m.text);
    else if (m.role === 'assistant') {
      cat.assistant += estTok(m.text) + estTok((m.tools ?? []).join(' '));
      cat.thinking += estTok(m.thinking);
    } else cat.tool += estTok(m.text ?? m.output ?? '');
  }
  const total = lastCtxUsage?.tokens ?? 0;
  const msgSum = cat.user + cat.assistant + cat.thinking + cat.tool;
  const sys = Math.max(0, total - msgSum); // envelope/steering/system residue
  const rows = [
    ['系统·信封', sys, 'var(--g500)'],
    ['用户消息', cat.user, 'var(--green)'],
    ['助手回复', cat.assistant, '#6ea8fe'],
    ['思考', cat.thinking, '#b98cf0'],
    ['工具结果', cat.tool, 'var(--yellow)'],
  ].filter(([, v]) => v > 0);
  const sum = rows.reduce((a, [, v]) => a + v, 0) || 1;
  const box = $('ctx-pop');
  box.innerHTML = `<div class="ctx-title">上下文分解（估算）· ${total.toLocaleString()} tok</div>
    <div class="ctx-bar">${rows.map(([n, v, c]) => `<span style="width:${(100 * v / sum).toFixed(1)}%;background:${c}" title="${n}"></span>`).join('')}</div>
    ${rows.map(([n, v, c]) => `<div class="ctx-row"><i style="background:${c}"></i><span>${n}</span><b>${Math.round(v).toLocaleString()}</b><em>${Math.round(100 * v / sum)}%</em></div>`).join('')}`;
  box.classList.toggle('hidden');
}
$('usage-chip').onclick = () => showCtxBreakdown();
document.addEventListener('click', (e) => {
  const pop = $('ctx-pop');
  if (pop && !pop.classList.contains('hidden') && !pop.contains(e.target) && e.target.id !== 'usage-chip') pop.classList.add('hidden');
});

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

/* ---------- generic context menu ---------- */
let ctxMenu = null;
function closeCtxMenu() { ctxMenu?.remove(); ctxMenu = null; }
document.addEventListener('click', closeCtxMenu);
window.addEventListener('blur', closeCtxMenu);
function showCtxMenu(x, y, items) {
  closeCtxMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ctx-item';
    b.textContent = it.label;
    b.onclick = async (e) => { e.stopPropagation(); closeCtxMenu(); await it.run(); };
    ctxMenu.appendChild(b);
  }
  document.body.appendChild(ctxMenu);
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  ctxMenu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
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
// Full-text hits from session_search — Map(path → [snippets]); null when the
// filter is too short to bother the backend.
let searchHits = null;
let showArchived = false;
function renderSessions() {
  const box = $('session-list');
  const filter = $('side-filter').value.trim().toLowerCase();
  box.innerHTML = '';
  const hasArchived = sessionsCache.some((s) => s.archived);
  const items = sessionsCache
    .filter((s) => showArchived || !s.archived)
    .filter((s) => !filter
      || `${s.name ?? ''} ${s.firstMessage ?? ''}`.toLowerCase().includes(filter)
      || searchHits?.has(s.path))
    .sort((a, b) => (Number(b.pinned ?? 0) - Number(a.pinned ?? 0))
      || String(b.modified ?? '').localeCompare(String(a.modified ?? '')));
  if (hasArchived) {
    const t = document.createElement('button');
    t.className = 'sess-arch-toggle';
    t.textContent = showArchived ? '收起归档' : `显示归档（${sessionsCache.filter((s) => s.archived).length}）`;
    t.onclick = () => { showArchived = !showArchived; renderSessions(); };
    box.appendChild(t);
  }
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
      row.className = `sess${s.path === currentSessionFile ? ' active' : ''}${s.archived ? ' archived' : ''}`;
      const title = s.name || s.firstMessage || '未命名任务';
      row.innerHTML = `<span class="sess-title"></span><span class="sess-meta">${s.pinned ? '📌 ' : ''}${s.messageCount ?? 0} 条</span>`;
      row.querySelector('.sess-title').textContent = title.length > 40 ? `${title.slice(0, 40)}…` : title;
      const hit = searchHits?.get(s.path);
      if (hit?.length && !`${s.name ?? ''} ${s.firstMessage ?? ''}`.toLowerCase().includes(filter)) {
        const snip = document.createElement('div');
        snip.className = 'sess-snip';
        snip.textContent = hit[0];
        row.appendChild(snip);
      }
      row.title = s.path;
      row.onclick = () => switchSession(s.path);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, [
          { label: '打开', run: () => switchSession(s.path) },
          {
            label: s.pinned ? '取消置顶' : '置顶',
            run: async () => {
              await cmd('session_pin', { path: s.path, pinned: !s.pinned });
              refreshSessions();
            },
          },
          {
            label: s.archived ? '取消归档' : '归档',
            run: async () => {
              await cmd('session_archive', { path: s.path, archived: !s.archived });
              refreshSessions();
            },
          },
          {
            label: '重命名…',
            run: async () => {
              const name = prompt('会话名字', s.name || s.firstMessage || '');
              if (name == null || !name.trim()) return;
              // rename acts on the live session — switching first is honest
              if (s.path !== currentSessionFile) await switchSession(s.path);
              const r = await cmd('session_rename', { name: name.trim() });
              if (!r.success) addSys(`重命名失败：${r.error ?? '未知'}`, true);
              refreshSessions(); refreshState();
            },
          },
          {
            label: '导出为 HTML',
            run: async () => {
              if (s.path !== currentSessionFile) await switchSession(s.path);
              const r = await cmd('session_export');
              if (r.success && r.data?.file) toast(`已导出：${r.data.file}`);
              else addSys(`导出失败：${r.error ?? '未知'}`, true);
            },
          },
          {
            label: '分支会话',
            run: async () => {
              // fork copies the transcript and switches into the copy
              const r = await cmd('session_fork', { path: s.path });
              if (!r.success) addSys(`分支失败：${r.error ?? '未知'}`, true);
              else { toast('已分支——当前在新会话里继续'); refreshSessions(); }
            },
          },
          { label: '复制会话路径', run: () => navigator.clipboard?.writeText(s.path) },
          {
            label: '删除会话…',
            run: async () => {
              if (!confirm(`删除会话「${title}」？会话文件会被移除，不可恢复。`)) return;
              if (s.path === currentSessionFile) { addSys('不能删除当前打开的会话——先切到别的会话', true); return; }
              const r = await cmd('session_delete', { path: s.path });
              if (!r.success) addSys(`删除失败：${r.error ?? '未知'}`, true);
              else { toast('会话已删除'); refreshSessions(); }
            },
          },
        ]);
      };
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
let searchTimer = null;
$('side-filter').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('side-filter').value.trim();
  if (q.length < 2) { searchHits = null; renderSessions(); return; }
  searchTimer = setTimeout(async () => {
    const r = await cmd('session_search', { query: q });
    searchHits = r.success ? new Map((r.data ?? []).map((h) => [h.path, h.snippets])) : null;
    renderSessions();
  }, 300);
});

/* ---------- model / thinking chips ---------- */
const chipMenu = $('chip-menu');
function closeMenu() { chipMenu.classList.add('hidden'); chipMenu.innerHTML = ''; }
document.addEventListener('click', (e) => {
  if (!chipMenu.contains(e.target) && e.target.id !== 'model-chip' && e.target.id !== 'thinking-chip' && e.target.id !== 'mode-chip') closeMenu();
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
  const ar = await cmd('model_alias_list');
  const aliases = ar.success ? (ar.data ?? []) : [];
  const items = models.map((m) => {
    const caps = m.capabilities ?? {};
    const badges = [caps.vision ? '图' : null, caps.reasoning ? '思' : null].filter(Boolean).join('·');
    return {
      label: m.name ?? m.id,
      sub: [m.provider, badges].filter(Boolean).join(' · '),
      current: cur && m.provider === cur.provider && m.id === cur.id,
      value: m,
    };
  });
  if (aliases.length) {
    items.push({ label: '— 别名 —', sub: '', value: null });
    for (const a of aliases) {
      items.push({ label: `@${a.name}`, sub: `${a.provider}/${a.model}`, value: { alias: a.name } });
    }
  }
  openMenu(items, async (it) => {
    if (!it.value) return;
    const r2 = it.value.alias
      ? await cmd('model_set', { alias: it.value.alias })
      : await cmd('model_set', { provider: it.value.provider, model: it.value.id });
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
  // first-run tour: model configured + never dismissed + no messages yet
  $('tour-card')?.classList.toggle('hidden',
    sawMessage || noModel || localStorage.getItem('pai.onboarded') === '1');
  if (!sawMessage && noModel) $('empty-state')?.classList.add('hidden');
  else $('empty-state')?.classList.remove('hidden');
  updateChips();
}
function updateChips() {
  const cur = modelStatus?.current;
  $('model-chip').textContent = cur ? `${cur.name ?? cur.id} ▾` : '选择模型 ▾';
  $('thinking-chip').textContent = `推理 ${THINK_LABEL[modelStatus?.thinkingLevel ?? 'medium']} ▾`;
}

/* ---------- theme: UI-local preference (localStorage, zero governance) ---------- */
const THEME_KEY = 'pai.theme';
function applyTheme(name) {
  document.documentElement.dataset.theme = name === 'light' ? 'light' : '';
}
applyTheme(localStorage.getItem(THEME_KEY) ?? 'dark');
if ($('set-theme')) {
  $('set-theme').value = localStorage.getItem(THEME_KEY) ?? 'dark';
  $('set-theme').onchange = () => {
    const v = $('set-theme').value;
    localStorage.setItem(THEME_KEY, v);
    applyTheme(v);
  };
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
$('tour-dismiss').onclick = () => {
  localStorage.setItem('pai.onboarded', '1');
  $('tour-card')?.classList.add('hidden');
};

/* ---------- modes editor (settings) — project .pai/modes.json ---------- */
async function refreshModesCard() {
  const list = $('modes-list');
  if (!list) return;
  const [r, rd] = await Promise.all([cmd('mode_list'), cmd('modes_read')]);
  const modes = r.success ? (r.data?.modes ?? []) : [];
  $('modes-active').textContent = r.success ? (r.data?.active ?? 'normal') : '';
  list.innerHTML = modes.length
    ? modes.map((m) => `<div class="mode-row"><span class="mode-name"></span><span class="dim mode-src"></span></div>`).join('')
    : '<div class="dim" style="padding:6px 0">无预设——下方 JSON 保存即创建项目模式</div>';
  modes.forEach((m, i) => {
    const row = list.children[i];
    row.querySelector('.mode-name').textContent = `${m.name}${m.description ? ` — ${m.description}` : ''}`;
    row.querySelector('.mode-src').textContent = m.source ?? '';
  });
  if (rd?.success) $('modes-json').value = rd.data.content ?? '';
}
$('modes-save') && ($('modes-save').onclick = async () => {
  const r = await cmd('modes_save', { content: $('modes-json').value });
  const msg = $('modes-msg');
  if (r.success) { msg.textContent = `已保存 ${r.data.presets} 个预设`; msg.className = 'setup-msg ok'; }
  else { msg.textContent = `保存失败：${r.error}`; msg.className = 'setup-msg err'; }
  refreshModesCard(); refreshMode();
});
/* command prefix lists — .pai/commands.json (deny) + command-allow.json (ask bypass) */
async function refreshCommandsCard() {
  if (!$('commands-json')) return;
  const [d, a] = await Promise.all([cmd('commands_read'), cmd('command_allow_read')]);
  if (d?.success) $('commands-json').value = d.data.content || '';
  if (a?.success) $('command-allow-json').value = a.data.content || '';
}
$('commands-save') && ($('commands-save').onclick = async () => {
  const r = await cmd('commands_save', { content: $('commands-json').value });
  const msg = $('commands-msg');
  if (r.success) { msg.textContent = '已保存'; msg.className = 'setup-msg ok'; }
  else { msg.textContent = `保存失败：${r.error}`; msg.className = 'setup-msg err'; }
});
$('command-allow-save') && ($('command-allow-save').onclick = async () => {
  const r = await cmd('command_allow_save', { content: $('command-allow-json').value });
  const msg = $('command-allow-msg');
  if (r.success) { msg.textContent = '已保存——命中前缀的命令不再弹批准卡'; msg.className = 'setup-msg ok'; }
  else { msg.textContent = `保存失败：${r.error}`; msg.className = 'setup-msg err'; }
});
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
  const pol = await cmd('policy_status');
  if (pol.success) renderGovCard(pol.data);
  refreshWorkspaces();
}
const RISK_LABEL = { benign: '常规', mutating: '改文件', destructive: '删改', network: '网络', privilege: '提权', exec: '执行', unknown: '未知' };
const ACTION_LABEL = { allow: '放行', deny: '拒绝', ask: '询问' };
function renderGovCard(p) {
  const rows = Object.entries(p.riskActions ?? {});
  $('gov-actions').innerHTML = rows.length
    ? rows.map(([risk, act]) => `<div class="set-row gov-row"><span class="pill">${RISK_LABEL[risk] ?? risk}</span><span class="gov-act ${act === 'deny' ? 'deny' : act === 'ask' ? 'warn' : ''}">${ACTION_LABEL[act] ?? act}</span></div>`).join('')
    : '<div class="set-sub">无风险映射</div>';
  const denied = p.deniedTools ?? [];
  $('gov-denied').textContent = denied.length ? `禁用工具：${denied.join('、')}` : '无显式禁用工具';
  $('gov-sum').textContent = `${rows.length} 条规则`;
  $('gov-checksum').textContent = (p.checksum ?? '').slice(0, 16);
  const b = p.budget;
  $('gov-denied').textContent += (b && (b.maxTokensPerSession || b.maxCostPerSessionUsd || b.maxCallsPerSession))
    ? `；预算上限：${[b.maxTokensPerSession && `${b.maxTokensPerSession} tok`, b.maxCostPerSessionUsd && `$${b.maxCostPerSessionUsd}`, b.maxCallsPerSession && `${b.maxCallsPerSession} 次调用`].filter(Boolean).join(' · ')}`
    : '；无预算上限（所有用量仍记 append-only 账）';
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

/* Workspace registry (U9) — remembered roots under the workdir card. */
async function refreshWorkspaces() {
  const box = $('workspace-list');
  if (!box) return;
  const r = await cmd('workspace_list');
  const list = r.data?.workspaces ?? [];
  box.innerHTML = '';
  if (!r.success || !list.length) {
    box.innerHTML = '<div class="set-sub">尚未登记工作区——切换工作目录会自动登记。</div>';
    return;
  }
  for (const w of list) {
    const row = document.createElement('div');
    row.className = `ws-row${w.active ? ' active' : ''}`;
    row.innerHTML = `<span class="ws-name"></span><code class="ws-path"></code><span class="ws-when dim"></span><span class="spacer"></span>`;
    row.querySelector('.ws-name').textContent = w.name ?? '';
    row.querySelector('.ws-path').textContent = w.path;
    row.querySelector('.ws-path').title = w.path;
    row.querySelector('.ws-when').textContent = w.lastUsedAt ? new Date(w.lastUsedAt).toLocaleDateString('zh-CN') : '';
    if (w.active) {
      row.insertAdjacentHTML('beforeend', '<span class="pill ok">当前</span>');
    } else {
      const sw = document.createElement('button');
      sw.className = 'btn ghost sm';
      sw.textContent = w.exists ? '切换' : '目录已不存在';
      sw.disabled = !w.exists;
      sw.onclick = async () => {
        const rr = await cmd('set_workdir', { path: w.path });
        if (!rr.success) toast(`切换失败：${rr.error ?? '未知'}`, 'err');
        refreshSettings();
      };
      const rm = document.createElement('button');
      rm.className = 'btn ghost sm';
      rm.textContent = '移除';
      rm.onclick = async () => { await cmd('workspace_remove', { path: w.path }); refreshWorkspaces(); };
      row.append(sw, rm);
    }
    box.appendChild(row);
  }
}
$('ws-add').onclick = async () => {
  const res = await fetch('/api/pick-dir', { method: 'POST' }).then((r) => r.json()).catch(() => ({}));
  const dir = res?.dir ?? prompt('要登记的工作区目录完整路径');
  if (!dir) return;
  const r = await cmd('workspace_add', { path: dir });
  if (!r.success) toast(`登记失败：${r.error ?? '未知'}`, 'err');
  refreshWorkspaces();
};

/* ---------- audit / jobs ---------- */
const AUDIT_GROUPS = {
  全部: null,
  治理: /TOOL_CALL_|GOVERNANCE_|PREDICTION_|FILEOP_|POLICY/,
  '身体/租约': /LEASE_|HANDOFF|BODY_|SUPERVISOR|SESSION_/,
  '计费/请求': /PROVIDER_|TURN_ACCOUNTING|MODEL_/,
};
let auditCache = [];
let auditFilter = '全部';

function auditKindClass(kind) {
  if (/DENIED|FAIL|ERROR|DRIFT|LOST/.test(kind)) return 'bad';
  if (/ASK/.test(kind)) return 'warn';
  if (/PROVIDER_|TURN_ACCOUNTING/.test(kind)) return 'dim';
  return '';
}
function renderAuditFilters() {
  const box = $('audit-filters');
  box.innerHTML = '';
  for (const g of Object.keys(AUDIT_GROUPS)) {
    const b = document.createElement('button');
    b.className = `af-chip${auditFilter === g ? ' on' : ''}`;
    b.textContent = g;
    b.onclick = () => { auditFilter = g; renderAuditFilters(); renderAuditList(); };
    box.appendChild(b);
  }
}
function renderAuditList() {
  const list = $('audit-list');
  list.innerHTML = '';
  const re = AUDIT_GROUPS[auditFilter];
  const rows = auditCache.filter((e) => !re || re.test(e.kind ?? ''));
  if (!rows.length) { list.innerHTML = '<div class="sys">暂无匹配事件</div>'; return; }
  for (const e of rows) {
    const kind = e.kind ?? '';
    const div = document.createElement('div');
    div.className = 'audit-row';
    div.innerHTML = `<span class="a-kind ${auditKindClass(kind)}"></span><span class="a-ts"></span><span class="a-run"></span><div class="a-detail hidden"></div>`;
    div.querySelector('.a-kind').textContent = kind;
    div.querySelector('.a-ts').textContent = (e.ts ?? e.time ?? '').slice(11, 19);
    div.querySelector('.a-run').textContent = e.toolName ?? (e.runId ? `run ${String(e.runId).slice(0, 8)}` : '');
    const detail = div.querySelector('.a-detail');
    const payload = { ...(e.data ?? {}) };
    detail.textContent = Object.keys(payload).length ? JSON.stringify(payload, null, 2) : '（无附加数据）';
    div.onclick = () => detail.classList.toggle('hidden');
    list.appendChild(div);
  }
}
async function refreshAudit() {
  const r = await cmd('audit_tail', { n: 80 });
  auditCache = (r.data ?? []).slice().reverse();
  renderAuditFilters();
  renderAuditList();
}
/* ---------- DSH projection (goal line) ---------- */
let lastProjection = null;
function paintGoalLine() {
  const el = $('goal-line');
  if (!el) return;
  const p = lastProjection;
  const goal = p?.goal ?? p?.goalIdentity ?? p?.summary ?? null;
  const subs = p?.subagents ?? p?.children ?? null;
  const text = typeof goal === 'string' && goal ? goal : null;
  if (!text && !(Array.isArray(subs) && subs.length)) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = (text ? `目标：${text}` : '')
    + (Array.isArray(subs) && subs.length ? `${text ? '　' : ''}子代理 ×${subs.length}` : '');
}

async function refreshJobs() {
  paintGoalLine();
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
    tr.classList.add('clickable');
    tr.title = j.command ?? '';
    tr.onclick = () => openJobDetail(j.job_id);
    tbody.appendChild(tr);
  }
  refreshTasks();
}

/* ---------- AgentTask mailbox center (F-family) ---------- */
let activeTask = null;

async function refreshTasks() {
  const tbody = $('tasks').querySelector('tbody');
  tbody.innerHTML = '';
  const r = await cmd('task_list');
  const tasks = r.success ? (r.data ?? []) : [];
  if (!tasks.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-4);padding:20px">暂无协作任务——delegate_task 委派自动建档</td></tr>';
    return;
  }
  // 委派拓扑：parent_task_id 指向可见任务时按父子树缩进，孤儿/根并列
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const kids = new Map();
  const roots = [];
  for (const t of tasks) {
    const p = t.parent_task_id;
    if (p && byId.has(p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(t); }
    else roots.push(t);
  }
  const ordered = [];
  const walk = (t, depth) => {
    ordered.push({ t, depth });
    for (const c of kids.get(t.task_id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const { t, depth } of ordered) {
    const tr = document.createElement('tr');
    const cells = [t.task_id?.slice(0, 16) ?? '', t.label ?? '', t.state ?? '', (t.job_id ?? '').slice(0, 12), `收${t.inbox_count ?? 0}/发${t.outbox_count ?? 0}`];
    tr.innerHTML = cells.map(() => '<td></td>').join('');
    tr.querySelectorAll('td').forEach((td, i) => { td.textContent = cells[i]; });
    if (depth) {
      const td = tr.querySelectorAll('td')[1];
      td.style.paddingLeft = `${8 + depth * 16}px`;
      td.textContent = `└ ${td.textContent}`;
    }
    tr.classList.add('clickable');
    tr.onclick = () => openTask(t.task_id);
    tbody.appendChild(tr);
  }
  if (activeTask) paintTask(); // live stream follows the same refresh tick
}

async function openTask(taskId) {
  activeTask = taskId;
  const box = $('task-detail');
  box.classList.remove('hidden');
  await paintTask();
}

async function paintTask() {
  if (!activeTask) return;
  const r = await cmd('task_events', { taskId: activeTask });
  if (!r.success) { $('task-stream').innerHTML = `<div class="dim" style="padding:12px">${escHtml(r.error ?? '读取失败')}</div>`; return; }
  const stream = $('task-stream');
  stream.innerHTML = '';
  const rows = [
    ...(r.data.inbox ?? []).map((m) => ({ tag: '→子', cls: 'dir-in', body: m.body, ts: m.ts })),
    ...(r.data.outbox ?? []).map((m) => ({ tag: '子→', cls: 'dir-out', body: m.body, ts: m.ts })),
    ...(r.data.events ?? []).map((e) => ({ tag: e.kind, cls: 'dir-ev', body: e.data?.note ?? e.data?.body ?? JSON.stringify(e.data ?? {}), ts: e.ts })),
  ].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  for (const m of rows) {
    const div = document.createElement('div');
    div.className = `task-msg ${m.cls}`;
    div.innerHTML = `<span class="tm-tag"></span><span class="tm-body selectable"></span><span class="tm-ts dim"></span>`;
    div.querySelector('.tm-tag').textContent = m.tag;
    div.querySelector('.tm-body').textContent = String(m.body ?? '');
    div.querySelector('.tm-ts').textContent = (m.ts ?? '').slice(11, 19);
    stream.appendChild(div);
  }
  stream.scrollTop = stream.scrollHeight;
  const st = r.data.task?.state;
  $('task-send-input').disabled = st === 'closed';
  $('task-send-btn').disabled = st === 'closed';
}

$('task-send-btn').onclick = async () => {
  const body = $('task-send-input').value.trim();
  if (!body || !activeTask) return;
  $('task-send-input').value = '';
  const r = await cmd('task_send', { taskId: activeTask, body });
  if (!r.success) toast(`发送失败：${r.error ?? '未知'}`, 'err');
  await paintTask();
};
$('task-send-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('task-send-btn').click(); }
});
$('task-interrupt-btn').onclick = async () => {
  if (!activeTask || !confirm('中断该协作任务？绑定的 job 会被取消。')) return;
  const r = await cmd('task_interrupt', { taskId: activeTask });
  if (!r.success) toast(`中断失败：${r.error ?? '未知'}`, 'err');
  else toast('任务已中断');
  await paintTask(); refreshJobs();
};
$('task-close-btn').onclick = async () => {
  if (!activeTask) return;
  const r = await cmd('task_close', { taskId: activeTask });
  if (!r.success) toast(`关闭失败：${r.error ?? '未知'}`, 'err');
  await paintTask(); refreshTasks();
};
let taskTimer = null;
function refreshTaskSoon() {
  clearTimeout(taskTimer);
  if (activeTask) taskTimer = setTimeout(paintTask, 1500);
}

/* ---------- changes & artifacts (fileops receipt stream) ---------- */
const OP_LABEL = { write: '写入', create: '新建', delete: '删除', backup: '备份' };

async function refreshChanges() {
  const r = await cmd('fileops_list', { n: 200 });
  const tbody = $('changes').querySelector('tbody');
  tbody.innerHTML = '';
  const ops = r.data ?? [];
  if (!r.success) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-4);padding:28px">此身体不支持变更回执（fileops 不可用）</td></tr>';
    return;
  }
  if (!ops.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-4);padding:28px">暂无文件变更</td></tr>';
    return;
  }
  for (const op of ops) {
    const tr = document.createElement('tr');
    const artifact = op.op === 'create';
    tr.innerHTML = `
      <td><span class="op-badge op-${op.op}">${OP_LABEL[op.op] ?? op.op}${artifact ? ' · 产物' : ''}</span></td>
      <td class="change-path"></td>
      <td class="dim"></td>
      <td></td>`;
    tr.querySelector('.change-path').textContent = op.target ?? '';
    tr.querySelector('.change-path').title = op.target ?? '';
    tr.querySelector('td:nth-child(3)').textContent = op.at ? new Date(op.at).toLocaleString('zh-CN', { hour12: false }) : '';
    const actCell = tr.querySelector('td:last-child');
    // per-receipt diff preview — Trae 逐改动面板语义：先看差异再决定回滚
    const dbtn = document.createElement('button');
    dbtn.className = 'btn ghost sm';
    dbtn.textContent = '差异';
    dbtn.title = `回执 ${op.receiptId} — 备份与现状的 unified diff`;
    let diffRow = null;
    dbtn.onclick = async () => {
      if (diffRow) { diffRow.remove(); diffRow = null; return; }
      dbtn.disabled = true;
      const rd = await cmd('fileops_diff', { receiptId: op.receiptId });
      dbtn.disabled = false;
      diffRow = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      const body = rd.success && rd.data?.diffs?.length
        ? rd.data.diffs[0].diff
        : (rd.data?.skipped?.[0]?.reason ?? rd.error ?? '无差异（产物已不在）');
      td.innerHTML = '<pre class="change-diff"></pre>';
      td.querySelector('pre').textContent = body;
      diffRow.appendChild(td);
      tr.after(diffRow);
    };
    actCell.appendChild(dbtn);
    if (op.undoable) {
      const btn = document.createElement('button');
      btn.className = 'btn ghost sm';
      btn.textContent = op.op === 'create' ? '撤销新建' : '恢复';
      btn.title = `回执 ${op.receiptId} — 恢复到变更前状态`;
      btn.onclick = async () => {
        btn.disabled = true;
        const rr = await cmd('fileops_restore', { receiptId: op.receiptId });
        if (rr.success) { toast(`已恢复：${rr.data?.restored ?? op.target}`); refreshChanges(); }
        else { toast(`恢复失败：${rr.error ?? '未知'}`, 'err'); btn.disabled = false; }
      };
      actCell.appendChild(btn);
    }
    tbody.appendChild(tr);
  }
}

async function openJobDetail(jobId) {
  const panel = $('job-detail');
  const r = await cmd('job_status', { job_id: jobId });
  if (!r.success) { toast(`读取任务失败：${r.error ?? '未知'}`, 'err'); return; }
  const { job, attempts, lease, detail } = r.data ?? {};
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="jd-head"><span class="jd-title"></span><button class="ghost-btn jd-cancel hidden">停止任务</button><button class="icon-btn jd-close" title="关闭">✕</button></div>
    <div class="jd-grid">
      <div><span class="jd-k">状态</span><span class="jd-v"></span></div>
      <div><span class="jd-k">编排</span><span class="jd-v"></span></div>
      <div><span class="jd-k">尝试</span><span class="jd-v"></span></div>
      <div><span class="jd-k">写租约</span><span class="jd-v"></span></div>
      <div><span class="jd-k">退出码</span><span class="jd-v"></span></div>
      <div class="jd-full"><span class="jd-k">命令</span><pre class="jd-cmd"></pre></div>
    </div>
    <div class="jd-out-label">输出尾部</div>
    <pre class="jd-out"></pre>
    <div class="jd-out-label">最近事件</div>
    <pre class="jd-events"></pre>`;
  const vs = panel.querySelectorAll('.jd-v');
  panel.querySelector('.jd-title').textContent = job?.job_id ?? jobId;
  vs[0].textContent = job?.job_state ?? '—';
  vs[1].textContent = job?.orchestration_state ?? '—';
  vs[2].textContent = `${attempts ?? 0} 次`;
  vs[3].textContent = lease?.writer_id ? `持有：${lease.writer_id}` : '空闲';
  vs[4].textContent = detail?.exit_code ?? detail?.signal ?? '—';
  panel.querySelector('.jd-cmd').textContent = detail?.command ?? job?.job_type ?? '—';
  panel.querySelector('.jd-out').textContent = detail?.output_tail || '（暂无输出）';
  const evLines = (detail?.events ?? []).map((e) => `${(e.timestamp ?? '').slice(11, 19)}  ${e.event_type}`).join('\n');
  panel.querySelector('.jd-events').textContent = evLines || '（无事件）';
  const cancelBtn = panel.querySelector('.jd-cancel');
  const cancellable = detail?.running || (job?.job_state && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.job_state));
  if (cancellable) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.onclick = async () => {
      if (!confirm(`确定停止任务 ${jobId}？`)) return;
      const cr = await cmd('job_cancel', { job_id: jobId });
      if (cr.success) { toast(cr.data?.killed ? '任务已停止' : '任务已标记取消', 'ok'); openJobDetail(jobId); renderJobs(); }
      else toast(`停止失败：${cr.error ?? '未知'}`, 'err');
    };
  }
  panel.querySelector('.jd-close').onclick = () => panel.classList.add('hidden');
  panel.scrollIntoView({ block: 'nearest' });
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
  const stats = await cmd('session_stats');
  s.stats = stats.success ? stats.data : null;
  state = s;
  if (s.contextUsage) { lastCtxUsage = s.contextUsage; updateUsageChip(); }
  if (s.session?.file) currentSessionFile = s.session.file;
  const name = s.session?.name;
  if (currentView === 'chat') $('view-title').textContent = name || '当前任务';
  await refreshModels();
  renderSessions();
  paintStatusline();
}

/* Persistent statusline — the harness-standard bottom row: model, mode,
   context headroom, session cost, workdir. Refreshed with state/mode changes. */
async function paintStatusline() {
  const el = $('statusline');
  if (!el) return;
  const mode = await cmd('mode_list');
  const parts = [];
  const model = $('model-chip')?.textContent?.trim();
  if (model) parts.push(model);
  const activeMode = mode.success ? mode.data?.active : 'normal';
  parts.push(MODE_LABEL[activeMode] ?? activeMode);
  if (lastCtxUsage?.contextWindow) parts.push(`ctx ${Math.round(100 * (lastCtxUsage.tokens ?? 0) / lastCtxUsage.contextWindow)}%`);
  // Prefer the ledger total (session_stats.cost is a number in pi's
  // SessionStats) — incremental sessionCost drifts after compaction/reconnects.
  const costTotal = typeof state?.stats?.cost === 'number' ? state.stats.cost : sessionCost;
  if (costTotal > 0) parts.push(`$${Number(costTotal).toFixed(4)}`);
  // evidence-contract goals (Qwen goals panel analogue) — only when the task
  // launched with a requirements contract
  const g = state?.goals;
  if (g?.requirements?.length) {
    parts.push(g.lastAction === 'complete'
      ? `目标 ${g.requirements.length}/${g.requirements.length}✓`
      : `目标 ${g.requirements.length - (g.lastGaps?.length ?? 0)}/${g.requirements.length}${g.continuations ? `·续${g.continuations}` : ''}`);
  }
  const wd = state?.workdir;
  if (wd) parts.push(wd.split(/[\\/]/).pop() ?? wd);
  el.textContent = parts.join('  ·  ');
}
function refreshAll() { refreshBodies(); refreshState(); refreshJobs(); refreshAudit(); refreshSessions(); refreshSettings(); refreshMode(); refreshMacros(); refreshTodos(); }
function setStatus(t, kind) {
  $('status').textContent = t;
  $('status-dot').className = `dot${kind === 'err' ? ' err' : t === '就绪' ? ' on' : ''}`;
}

/* ---------- views ---------- */
const TITLES = { jobs: '任务', changes: '变更与产物', audit: '审计', bodies: '身体', settings: '设置' };
let currentView = 'chat';
function switchView(v) {
  currentView = v;
  for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('active', item.dataset.view === v);
  for (const sec of document.querySelectorAll('.view')) sec.classList.toggle('hidden', sec.id !== `view-${v}`);
  if (v === 'chat') $('view-title').textContent = sessionsCache.find((s) => s.path === currentSessionFile)?.name || '当前任务';
  else $('view-title').textContent = TITLES[v] ?? '';
  if (v === 'jobs') refreshJobs();
  if (v === 'changes') refreshChanges();
  if (v === 'audit') refreshAudit();
  if (v === 'bodies') refreshBodies();
  if (v === 'settings') { refreshSettings(); refreshModels(); refreshMemory(); refreshModesCard(); refreshCommandsCard(); }
}
for (const item of document.querySelectorAll('.nav-item')) item.onclick = () => switchView(item.dataset.view);
$('body-chip').onclick = () => switchView('bodies');

/* sidebar collapse — remembered across launches */
const applySide = (collapsed) => {
  document.body.classList.toggle('side-collapsed', collapsed);
  $('side-expand').classList.toggle('hidden', !collapsed);
  localStorage.setItem('pai.sideCollapsed', collapsed ? '1' : '');
};
$('side-toggle').onclick = () => applySide(true);
$('side-expand').onclick = () => applySide(false);
applySide(localStorage.getItem('pai.sideCollapsed') === '1');

/* ---------- composer ---------- */
const input = $('input');
function autogrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  $('send').disabled = busy ? false : !input.value.trim();
}
/* ---------- slash commands — every entry maps to a real command ---------- */
const SLASH = [
  { cmd: '/new', label: '新建任务', hint: '开一个干净会话', run: () => $('new-task').click() },
  { cmd: '/abort', label: '中止运行', hint: '停止当前任务', run: async () => { await cmd('abort'); } },
  { cmd: '/model', label: '选择模型', hint: '弹出模型菜单', run: () => $('model-chip').click() },
  { cmd: '/think', label: '推理强度', hint: '设置思考等级', run: () => $('thinking-chip').click() },
  {
    cmd: '/rename', label: '重命名会话', hint: '/rename 新名字',
    run: async (arg) => {
      if (!arg) { addSys('用法：/rename 新名字', true); return; }
      const r = await cmd('session_rename', { name: arg });
      if (!r.success) addSys(`重命名失败：${r.error ?? '未知'}`, true);
      refreshSessions(); refreshState();
    },
  },
  {
    cmd: '/compact', label: '压缩上下文', hint: '/compact 可选指令——立即总结窗口',
    run: async (arg) => {
      addSys('压缩上下文中…');
      const r = await cmd('session_compact', { instructions: arg || undefined });
      if (!r.success) addSys(`压缩失败：${r.error ?? '未知'}`, true);
      refreshState();
    },
  },
  {
    cmd: '/rewind', label: '回到某条消息', hint: '把会话头倒回任一提问点',
    run: async () => {
      const r = await cmd('session_entries');
      const items = (r.data ?? []).slice().reverse();
      if (!items.length) { addSys('没有可回退的提问点', true); return; }
      openMenu(items.map((e) => ({
        label: (e.text || '(空)').slice(0, 60),
        sub: e.entryId.slice(0, 8),
        value: e,
      })), async (it) => {
        // ZCode EscEsc scope choice: chat-only, files-only, both, or fork
        // a NEW session from this point (original timeline untouched).
        openMenu([
          { label: '仅回退会话', sub: '对话头回到该点，文件不动', value: 'chat' },
          { label: '仅回退文件', sub: '撤销该点之后的文件改动，对话不动', value: 'files' },
          { label: '会话+文件一起回退', sub: '回到该点的完整现场', value: 'both' },
          { label: '从此处开分叉会话', sub: '复制到该点为止的历史进新会话，原会话原样', value: 'fork' },
        ], async (scope) => {
          if (scope.value === 'fork') {
            const fr = await cmd('session_fork', { path: currentSessionFile, entryId: it.value.entryId });
            if (!fr.success) { addSys(`分叉失败：${fr.error ?? '未知'}`, true); return; }
            await replayHistory(); refreshSessions(); refreshState();
            toast('已分叉——当前会话切到从该点长出的新会话');
            return;
          }
          const r2 = await cmd('session_rewind', { entryId: it.value.entryId, scope: scope.value });
          if (!r2.success) { addSys(`回退失败：${r2.error ?? '未知'}`, true); return; }
          if (scope.value === 'files') {
            const n = r2.data?.restoredFiles?.length ?? 0;
            toast(`已回退文件：恢复 ${n} 处改动${r2.data?.partial ? '（部分失败）' : ''}`);
            refreshChanges();
            return;
          }
          if (r2.data?.editorText) { input.value = r2.data.editorText; autogrow(); }
          await replayHistory();
          refreshState();
          if (scope.value === 'both') refreshChanges();
          toast('已回退——之后的回合仍在文件里，未删除');
        });
      });
    },
  },
  {
    cmd: '/export', label: '导出会话', hint: '导出为 HTML（/export jsonl 导原始轨迹，/export debug 导含子任务链的调试包）',
    run: async (arg) => {
      const a = String(arg ?? '').trim().toLowerCase();
      const format = ['jsonl', 'debug'].includes(a) ? a : 'html';
      const r = await cmd('session_export', { format });
      if (r.success && r.data?.file) toast(`已导出：${r.data.file}`);
      else addSys(`导出失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    cmd: '/chat', label: '存档会话', hint: '/chat save 名字 存快照；/chat load 打开已存',
    run: async (arg) => {
      const [sub, ...rest] = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
      if (sub === 'save') {
        const name = rest.join(' ');
        if (!name) { addSys('用法：/chat save 名字', true); return; }
        const r = await cmd('session_save', { name });
        if (r.success) toast(`已存档：${r.data?.name ?? name}`);
        else addSys(`存档失败：${r.error ?? '未知'}`, true);
        return;
      }
      if (sub === 'load' || !sub) {
        const r = await cmd('session_saved_list');
        const items = r.data ?? [];
        if (!items.length) { addSys('没有已存会话——/chat save 名字 先存一个', true); return; }
        openMenu(items.map((s) => ({
          label: s.name, sub: new Date(s.modified).toLocaleString(), value: s,
        })), async (it) => {
          // Fork, not switch — the snapshot file stays pristine; the copy
          // becomes the live session (Gemini resume semantics).
          const r2 = await cmd('session_fork', { path: it.value.path });
          if (!r2.success) { addSys(`打开失败：${r2.error ?? '未知'}`, true); return; }
          await replayHistory(); refreshSessions(); refreshState();
          toast(`已恢复存档「${it.value.name}」——快照原件不动`);
        });
        return;
      }
      addSys('用法：/chat save 名字 | /chat load', true);
    },
  },
  {
    cmd: '/stats', label: '用量总览', hint: '跨会话聚合：会话数/消息/token/成本',
    run: async () => {
      const r = await cmd('agent_stats');
      if (!r.success) { addSys(`统计失败：${r.error ?? '未知'}`, true); return; }
      const s = r.data ?? {};
      addSys(`累计 ${s.sessions ?? 0} 个会话 · ${s.messages ?? 0} 条消息（你发了 ${s.userMessages ?? 0} 条）· ${(s.tokens ?? 0).toLocaleString()} tok · $${s.cost ?? 0}`
        + (s.firstSession ? `——自 ${new Date(s.firstSession).toLocaleDateString()} 起` : ''));
    },
  },
  {
    cmd: '/undo', label: '撤销上轮改动', hint: '恢复最近一次提问以来的全部文件操作',
    run: async () => {
      const [ops, ent] = await Promise.all([cmd('fileops_list'), cmd('session_entries')]);
      const undoable = (ops.data ?? []).filter((o) => o.undoable);
      if (!undoable.length) { addSys('没有可撤销的文件操作', true); return; }
      // Turn-scoped undo: receipts since the last user prompt, newest-first
      // restore order. No entries yet → just the single newest op.
      const lastTs = (ent.data ?? []).at(-1)?.ts;
      const scope = lastTs ? undoable.filter((o) => o.at >= lastTs) : undoable.slice(0, 1);
      if (!scope.length) { addSys('上一轮没有文件改动可撤销', true); return; }
      let restored = 0, failed = 0;
      for (const o of scope) {
        const r = await cmd('fileops_restore', { receiptId: o.receiptId });
        r.success ? restored++ : failed++;
      }
      addSys(`已撤销 ${restored} 项文件改动${failed ? `（${failed} 项失败）` : ''}——原始回执仍在变更面板可查`);
      refreshChanges?.();
    },
  },
  {
    cmd: '/diff', label: '查看改动聚合', hint: '最近文件改动的统一 diff（/diff N 指定条数）',
    run: async (arg) => {
      const n = Math.max(1, Math.min(50, parseInt(arg, 10) || 10));
      const r = await cmd('fileops_diff', { n });
      if (!r.success) { addSys(`diff 失败：${r.error ?? '未知'}`, true); return; }
      const { diffs = [], skipped = [] } = r.data ?? {};
      if (!diffs.length) { addSys('没有可展示的改动', true); return; }
      for (const d of diffs) {
        addDiffBlock(d.target.split(/[\\/]/).pop(), d.op, d.diff || '（无文本差异）');
      }
      if (skipped.length) addSys(`${skipped.length} 项回执无法 diff（备份工件已失）`, true);
    },
  },
  {
    cmd: '/btw', label: '旁路提问', hint: '临时分叉问一句，不污染当前会话',
    run: async (arg) => {
      if (!arg) { addSys('用法：/btw 你的问题', true); return; }
      addSys('旁路提问中——临时分叉，回答不进本会话记录…');
      const r = await cmd('session_btw', { message: arg });
      if (!r.success) { addSys(`旁路失败：${r.error ?? '未知'}`, true); return; }
      addDiffBlock('旁路回答', 'btw', r.data?.answer ?? '(无回答)');
    },
  },
  {
    cmd: '/restore', label: '恢复文件操作', hint: '按回执还原备份/回收站里的文件',
    run: async () => {
      const r = await cmd('fileops_list');
      const ops = (r.data ?? []).filter((o) => o.recoverable);
      if (!ops.length) { addSys('没有可恢复的文件操作回执', true); return; }
      openMenu(ops.slice(0, 20).map((o) => ({
        label: `${o.op === 'delete' ? '回收' : '备份'} · ${o.target.split(/[\\/]/).pop()}`,
        sub: `${o.receiptId} · ${new Date(o.at).toLocaleTimeString()}`,
        value: o,
      })), async (it) => {
        const r2 = await cmd('fileops_restore', { receiptId: it.value.receiptId });
        if (r2.success) toast(`已恢复：${r2.data.restored}`);
        else addSys(`恢复失败：${r2.error ?? '未知'}`, true);
      });
    },
  },
  {
    cmd: '/recipe', label: '任务包', hint: '运行 .pai/recipes/<name>.md——/recipe name 参数=值',
    run: async (arg) => {
      const recipes = await loadRecipes();
      if (!recipes.length) { addSys('没有任务包——在 workdir 下建 .pai/recipes/<name>.md（frontmatter: description/params，正文 {{参数}} 占位）', true); return; }
      const [name, ...kv] = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
      const run = async (r, args) => {
        const missing = (r.params ?? []).filter((p) => p.required && args[p.name] == null && p.default == null);
        if (missing.length) {
          addSys(`缺少参数：${missing.map((p) => p.name).join('、')}——用法：/recipe ${r.name} ${missing.map((p) => `${p.name}=值`).join(' ')}`, true);
          return;
        }
        let text = r.body;
        for (const p of r.params ?? []) {
          const v = args[p.name] ?? p.default ?? '';
          text = text.split(`{{${p.name}}}`).join(v);
        }
        input.value = text; autogrow();
        await send();
      };
      if (!name) {
        openMenu(recipes.map((r) => ({
          label: r.name, sub: r.description || '',
          value: r,
        })), async (it) => {
          const needArgs = (it.value.params ?? []).filter((p) => p.required && p.default == null);
          if (needArgs.length) {
            addSys(`/${it.value.name} 需要参数：${needArgs.map((p) => p.name).join('、')}——输入 /recipe ${it.value.name} ${needArgs.map((p) => `${p.name}=值`).join(' ')}`);
            input.value = `/recipe ${it.value.name} `; autogrow(); input.focus();
            return;
          }
          await run(it.value, {});
        });
        return;
      }
      const r = recipes.find((x) => x.name === name);
      if (!r) { addSys(`没有任务包 '${name}'——可用：${recipes.map((x) => x.name).join('、')}`, true); return; }
      const args = {};
      for (const pair of kv) {
        const i = pair.indexOf('=');
        if (i > 0) args[pair.slice(0, i)] = pair.slice(i + 1);
      }
      await run(r, args);
    },
  },
  {
    cmd: '/plans', label: '计划库', hint: '载入 .pai/plans/<name>.md 继续执行——agent 用 plan_save 固化',
    run: async (arg) => {
      const l = await cmd('files_list', { prefix: '.pai/plans/' });
      const files = (l.data?.files ?? []).filter((f) => f.endsWith('.md'));
      if (!files.length) { addSys('没有已存计划——agent 可用 plan_save 把计划固化到 .pai/plans/', true); return; }
      const pick = async (f) => {
        const r = await cmd('file_read', { path: f });
        if (!r.success || r.data?.content == null) { addSys(`读取失败：${f}`, true); return; }
        const name = f.replace(/^\.pai\/plans\//, '').replace(/\.md$/, '');
        input.value = `<plan name="${name}">\n${r.data.content.trim()}\n</plan>\n\n继续执行以上计划。`;
        autogrow();
        await send();
      };
      const name = String(arg ?? '').trim();
      if (!name) {
        openMenu(files.map((f) => ({ label: f.replace(/^\.pai\/plans\//, '').replace(/\.md$/, ''), value: f })), (it) => pick(it.value));
        return;
      }
      const f = files.find((x) => x === `.pai/plans/${name}.md`);
      if (!f) { addSys(`没有计划 '${name}'——可用：${files.map((x) => x.replace(/^\.pai\/plans\/|\.md$/g, '')).join('、')}`, true); return; }
      await pick(f);
    },
  },
  {
    cmd: '/review', label: '审查变更', hint: '切只读审查模式并审查当前变更（Codex /review 对等）',
    run: async () => {
      const r = await cmd('mode_set', { name: 'review' });
      if (!r.success) { addSys(`切审查模式失败：${r.error ?? '未知'}`, true); return; }
      refreshMode();
      input.value = '审查当前工作区的未提交变更：用 fileops 回执/git diff 看每个改动，指出问题、风险与建议修复，按严重度排序。';
      autogrow();
      await send();
    },
  },
  {
    cmd: '/plan', label: '计划模式', hint: '只读模式——改动类调用都要批准',
    run: async () => {
      const r = await cmd('risk_mode_set', { mode: 'plan' });
      if (r.success) { refreshMode(); toast('已切到计划模式：只读，改动会逐一询问'); }
      else addSys(`切换失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    cmd: '/act', label: '执行模式', hint: '恢复正常执行',
    run: async () => {
      const r = await cmd('risk_mode_set', { mode: 'normal' });
      if (r.success) { refreshMode(); toast('已切回执行模式'); }
      else addSys(`切换失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    cmd: '/reset', label: '回退会话+文件', hint: '会话倒回并把之后的文件改动一并还原',
    run: async () => {
      const r = await cmd('session_entries');
      const items = (r.data ?? []).slice().reverse();
      if (!items.length) { addSys('没有可回退的提问点', true); return; }
      openMenu(items.map((e) => ({
        label: (e.text || '(空)').slice(0, 60),
        sub: e.entryId.slice(0, 8),
        value: e,
      })), async (it) => {
        const r2 = await cmd('session_rewind', { entryId: it.value.entryId, restoreFiles: true });
        if (!r2.success) { addSys(`回退失败：${r2.error ?? '未知'}`, true); return; }
        if (r2.data?.editorText) { input.value = r2.data.editorText; autogrow(); }
        await replayHistory();
        refreshState();
        const n = r2.data?.restoredFiles?.length ?? 0;
        toast(`已回退${n ? `并还原 ${n} 个文件` : '（无文件改动要还原）'}`);
      });
    },
  },
  {
    cmd: '/macro', label: '保存宏', hint: '/macro 名字 模板文本——之后打 /名字 直接调用',
    run: async (arg) => {
      const sp = arg.indexOf(' ');
      const name = sp === -1 ? arg.trim() : arg.slice(0, sp).trim();
      const text = sp === -1 ? '' : arg.slice(sp + 1).trim();
      if (!name || !text) { addSys('用法：/macro 名字 模板文本', true); return; }
      const r = await cmd('macro_save', { name, text });
      if (r.success) { await refreshMacros(); toast(`宏 /${name} 已保存`); }
      else addSys(`保存失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    cmd: '/unmacro', label: '删除宏', hint: '/unmacro 名字',
    run: async (arg) => {
      const name = arg.trim();
      if (!name) { addSys('用法：/unmacro 名字', true); return; }
      const r = await cmd('macro_delete', { name });
      if (r.success) { await refreshMacros(); toast(`宏 /${name} 已删除`); }
      else addSys(`删除失败：${r.error ?? '未知'}`, true);
    },
  },
  { cmd: '/sessions', label: '任务列表', hint: '聚焦搜索框', run: () => { switchView('chat'); $('side-filter').focus(); } },
  { cmd: '/body', label: '身体面板', hint: '谁在驾驶', run: () => switchView('bodies') },
  { cmd: '/jobs', label: '持久任务', hint: '跨重启的任务', run: () => switchView('jobs') },
  { cmd: '/changes', label: '变更与产物', hint: '文件变更回执，可恢复', run: () => switchView('changes') },
  { cmd: '/audit', label: '审计日志', hint: '治理事件流', run: () => switchView('audit') },
  { cmd: '/settings', label: '设置', hint: '模型与工作目录', run: () => switchView('settings') },
  {
    cmd: '/clear', label: '清空开始', hint: '新会话（同 /new）', run: () => $('new-task').click(),
  },
  {
    cmd: '/resume', label: '继续会话', hint: '弹出会话选择器',
    run: async () => {
      const r = await cmd('session_list');
      const items = (r.data ?? []).filter((s) => s.path !== currentSessionFile);
      if (!items.length) { addSys('没有其它会话', true); return; }
      openMenu(items.slice(0, 20).map((s) => ({
        label: (s.name || s.firstMessage || '未命名任务').slice(0, 60),
        sub: `${s.messageCount ?? 0} 条`,
        value: s,
      })), (it) => switchSession(it.value.path));
    },
  },
  {
    cmd: '/fork', label: '分支会话', hint: '复制当前会话并切入副本',
    run: async () => {
      if (!currentSessionFile) { addSys('当前没有会话', true); return; }
      const r = await cmd('session_fork', { path: currentSessionFile });
      if (r.success) { toast('已分支——当前在新会话里继续'); refreshSessions(); }
      else addSys(`分支失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    cmd: '/status', label: '会话状态', hint: '模型/模式/上下文/预算一览',
    run: async () => {
      const [st, stats, mode] = await Promise.all([cmd('get_state'), cmd('session_stats'), cmd('risk_mode')]);
      const s = st.data ?? {};
      const u = s.contextUsage ?? stats.data?.contextUsage ?? {};
      const pct = u.contextWindow ? Math.round(100 * (u.tokens ?? 0) / u.contextWindow) : null;
      addSys([
        `会话：${currentSessionFile ? currentSessionFile.split(/[\\/]/).pop() : '（未开）'}`,
        `模型：${s.model?.id ?? ($('model-chip').textContent || '—')} · 模式：${mode.data?.mode ?? 'normal'}`,
        pct != null ? `上下文：${u.tokens ?? '?'} / ${u.contextWindow}（${pct}%）` : '上下文：—',
        `本会话成本：$${sessionCost.toFixed(4)}`,
        `工作目录：${s.workdir ?? '—'}`,
      ].join('\n'));
    },
  },
  {
    cmd: '/cost', label: '用量与成本', hint: '本会话 token/费用总账',
    run: async () => {
      const r = await cmd('session_stats');
      const s = r.data;
      if (!s) { addSys('暂无用量数据', true); return; }
      const u = s.usage ?? s;
      addSys(`累计：${u.totalTokens ?? u.tokens ?? '—'} tokens · $${(u.cost?.total ?? u.totalCost ?? sessionCost).toFixed ? (u.cost?.total ?? u.totalCost ?? sessionCost).toFixed(4) : '—'} · 消息 ${s.messageCount ?? '—'} 条 · 压缩 ${s.compactionCount ?? 0} 次`);
    },
  },
  {
    cmd: '/doctor', label: '配置检视', hint: '有效姿态一览——模式/政策/记忆/目标/自动化配置（agent debug 对等）',
    run: async () => {
      const [st, pol, modes, mem, aliases] = await Promise.all([
        cmd('get_state'), cmd('policy_status'), cmd('mode_list'), cmd('memory_stats'), cmd('model_alias_list'),
      ]);
      const s = st.data ?? {};
      const p = pol.data ?? {};
      const g = s.goals;
      const counts = {};
      for (const dir of ['steering', 'microagents', 'recipes', 'plans', 'agents']) {
        const l = await cmd('files_list', { prefix: `.pai/${dir}/` }).catch(() => null);
        counts[dir] = l?.success ? (l.data?.files ?? []).length : 0;
      }
      addSys([
        `模型：${s.model?.id ?? '—'} · 模式：${modes.data?.active ?? 'normal'} · 政策指纹：${String(p.checksum ?? '—').slice(0, 12)}`,
        `规则：${Object.keys(p.toolRules ?? {}).length} 条工具规则 · 禁表：${(p.deniedTools ?? []).length} 项 · 预算：${p.budget ? '已配' : '未配'}`,
        `记忆：${mem.data ? `${mem.data.total ?? mem.data.rows ?? '—'} 条（置顶 ${mem.data.pinned ?? 0}）` : '—'}`,
        g?.requirements?.length ? `目标契约：${g.requirements.length} 项 · 续 ${g.continuations}/${g.maxContinuations} · 最近：${g.lastAction ?? '—'}` : '目标契约：未挂',
        `.pai 面：steering×${counts.steering} microagents×${counts.microagents} recipes×${counts.recipes} plans×${counts.plans} agents×${counts.agents}`,
        `别名：${(aliases.data ?? []).length} 个 · 会话：${s.session?.name ?? '（未开）'} · 上下文：${s.contextUsage?.tokens ?? '?'}/${s.contextUsage?.contextWindow ?? '?'}`,
      ].join('\n'));
    },
  },
  {
    cmd: '/init', label: '生成 AGENTS.md', hint: '让模型分析 workdir 并写项目说明',
    run: async () => {
      input.value = '分析当前工作目录的结构与约定，生成一份 AGENTS.md 写进根目录——覆盖：项目用途、目录结构、构建/测试命令、代码风格、提交规范。';
      await send();
    },
  },
  {
    cmd: '/help', label: '帮助', hint: '全部命令与快捷键',
    run: async () => {
      addSys([
        '斜杠命令：' + SLASH.map((s) => s.cmd).join(' '),
        '@路径 — 附着文件内容进上下文（自动补全）',
        'Enter 发送 · Shift+Enter 换行 · Esc 中止运行 · ↑ 召回上一条 · Ctrl+K 命令面板',
        '运行中发送 = 排队插话；点"转向"立即打断注入',
      ].join('\n'));
    },
  },
];
const slashMenu = $('slash-menu');
let slashIdx = 0;
let slashItems = [];
let MACROS = {}; // user-defined prompt macros — /name expands to template text
let atToken = null; // active @file-ref token {start,end,prefix} or null

async function refreshMacros() {
  const r = await cmd('macro_list');
  if (r.success) MACROS = r.data?.macros ?? {};
}

/* ---------- memory (G-family): operator review surface ---------- */
async function refreshMemory() {
  const box = $('mem-list');
  if (!box) return;
  const q = $('mem-query')?.value.trim() ?? '';
  const r = await cmd('memory_list', q ? { query: q } : {});
  if (!r.success) { box.innerHTML = `<div class="dim" style="padding:8px">${escHtml(r.error ?? '此身体不支持记忆面')}</div>`; return; }
  const rows = r.data ?? [];
  box.innerHTML = '';
  if (!rows.length) { box.innerHTML = '<div class="dim" style="padding:8px">暂无记忆——模型经 memory_save 沉淀，或点上方添加</div>'; return; }
  for (const m of rows) {
    const div = document.createElement('div');
    div.className = 'mem-row';
    div.innerHTML = `<span class="mem-pin" title="置顶注入"></span><span class="mem-text selectable"></span><span class="mem-kind dim"></span><button class="mem-forget" title="遗忘">×</button>`;
    const pin = div.querySelector('.mem-pin');
    pin.textContent = m.pinned ? '📌' : '·';
    pin.classList.toggle('on', !!m.pinned);
    pin.onclick = async () => { await cmd('memory_pin', { id: m.id, pinned: !m.pinned }); refreshMemory(); };
    div.querySelector('.mem-text').textContent = m.text;
    div.querySelector('.mem-text').title = `${m.id} · ${m.source} · 置信 ${m.confidence} · ${m.updated}`;
    div.querySelector('.mem-kind').textContent = m.kind;
    div.querySelector('.mem-forget').onclick = async () => {
      if (!confirm(`遗忘这条记忆？\n${m.text.slice(0, 120)}`)) return;
      await cmd('memory_forget', { id: m.id });
      refreshMemory();
    };
    box.appendChild(div);
  }
}
$('mem-add-btn').onclick = async () => {
  const text = prompt('记住什么？（一句话事实/偏好/决定）');
  if (!text?.trim()) return;
  const r = await cmd('memory_save', { text: text.trim() });
  if (r.success) { toast('已记住'); refreshMemory(); }
  else toast(`写入被拒：${r.error ?? '未知'}`, 'err');
};
$('mem-query')?.addEventListener('input', () => {
  clearTimeout($('mem-query')._t);
  $('mem-query')._t = setTimeout(refreshMemory, 300);
});

const MODE_LABEL = { normal: '执行', plan: '计划' };
async function refreshMode() {
  const chip = $('mode-chip');
  // mode_list carries preset overlays too; risk_mode is the legacy fallback
  const r = await cmd('mode_list');
  const active = r.success ? r.data?.active : (await cmd('risk_mode'))?.data?.mode;
  const name = active ?? 'normal';
  chip.textContent = MODE_LABEL[name] ?? name;
  chip.classList.toggle('plan', name !== 'normal');
  paintStatusline();
}
$('mode-chip').onclick = async () => {
  if (!chipMenu.classList.contains('hidden')) { closeMenu(); return; }
  const r = await cmd('mode_list');
  if (!r.success) { // body without preset support — keep the binary toggle
    const cur = (await cmd('risk_mode'))?.data?.mode === 'plan' ? 'plan' : 'normal';
    const r2 = await cmd('risk_mode_set', { mode: cur === 'plan' ? 'normal' : 'plan' });
    if (r2.success) { refreshMode(); toast(r2.data.mode === 'plan' ? '计划模式：改动类调用会逐一询问' : '执行模式'); }
    return;
  }
  const { modes, active } = r.data;
  openMenu(modes.map((m) => ({
    label: MODE_LABEL[m.name] ?? m.name,
    sub: m.description || m.source,
    current: m.name === active,
    value: m.name,
  })), async (it) => {
    const r2 = await cmd('mode_set', { name: it.value });
    if (r2.success) { refreshMode(); toast(`模式：${it.label}`); }
    else toast(r2.error ?? '切换失败');
  });
};

function slashFilter() {
  const v = input.value;
  // @file-ref autocomplete: a @token anywhere (start or after whitespace)
  const upto = v.slice(0, input.selectionStart);
  const m = upto.match(/(?:^|\s)@([\w./\\-]*)$/);
  if (m) { atComplete(m, input.selectionStart); return; }
  atToken = null;
  if (!v.startsWith('/') || v.includes('\n')) { closeSlash(); return; }
  const head = v.slice(1).split(/\s+/)[0].toLowerCase();
  slashItems = SLASH.filter((s) => s.cmd.slice(1).startsWith(head))
    .concat(Object.keys(MACROS)
      .filter((n) => n.toLowerCase().startsWith(head))
      .map((n) => ({ cmd: `/${n}`, label: '宏', hint: MACROS[n].slice(0, 60), macro: MACROS[n] })));
  if (!slashItems.length) { closeSlash(); return; }
  slashIdx = Math.min(slashIdx, slashItems.length - 1);
  slashMenu.innerHTML = '';
  slashItems.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = `slash-item${i === slashIdx ? ' sel' : ''}`;
    b.innerHTML = '<span class="sl-cmd"></span><span class="sl-label"></span><span class="sl-hint"></span>';
    b.querySelector('.sl-cmd').textContent = s.cmd;
    b.querySelector('.sl-label').textContent = s.label;
    b.querySelector('.sl-hint').textContent = s.hint ?? '';
    b.onmouseenter = () => { slashIdx = i; paintSlashSel(); };
    b.onclick = () => execSlash(s);
    slashMenu.appendChild(b);
  });
  slashMenu.classList.remove('hidden');
}

let atSeq = 0;
async function atComplete(m, caret) {
  const prefix = m[1];
  atToken = { start: caret - prefix.length - 1, end: caret, prefix };
  const seq = ++atSeq;
  const r = await cmd('files_list', { prefix });
  if (seq !== atSeq || !r.success) return;
  const files = (r.data?.files ?? []).slice(0, 12);
  if (!files.length) { closeSlash(); return; }
  slashItems = files.map((f) => ({ cmd: `@${f}`, label: f, file: f }));
  slashIdx = 0;
  slashMenu.innerHTML = '';
  slashItems.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = `slash-item${i === slashIdx ? ' sel' : ''}`;
    b.innerHTML = '<span class="sl-cmd"></span><span class="sl-label"></span>';
    b.querySelector('.sl-cmd').textContent = '📄';
    b.querySelector('.sl-label').textContent = s.file;
    b.onmouseenter = () => { slashIdx = i; paintSlashSel(); };
    b.onclick = () => execSlash(s);
    slashMenu.appendChild(b);
  });
  slashMenu.classList.remove('hidden');
}
function paintSlashSel() {
  [...slashMenu.children].forEach((el, i) => el.classList.toggle('sel', i === slashIdx));
}
function closeSlash() { slashMenu.classList.add('hidden'); slashItems = []; slashIdx = 0; atToken = null; }
async function execSlash(s) {
  // file-ref / macro entries edit the draft, not execute a command
  if (s.file && atToken) {
    const v = input.value;
    input.value = v.slice(0, atToken.start) + `@${s.file} ` + v.slice(atToken.end);
    input.selectionStart = input.selectionEnd = atToken.start + s.file.length + 2;
    closeSlash(); autogrow(); input.focus();
    return;
  }
  if (s.macro != null) {
    closeSlash();
    input.value = s.macro; autogrow(); input.focus();
    return;
  }
  const arg = input.value.slice(1).split(/\s+/).slice(1).join(' ').trim();
  closeSlash();
  input.value = ''; autogrow();
  await s.run(arg);
}

/* Per-session composer drafts (PI reference): text survives session
 * switches — keyed by session file, cleared on send. */
const draftKey = () => `pai.draft.${currentSessionFile ?? 'new'}`;
function loadDraft() {
  input.value = localStorage.getItem(draftKey()) ?? '';
  autogrow();
}
input.addEventListener('input', () => { autogrow(); slashFilter(); localStorage.setItem(draftKey(), input.value); });
input.addEventListener('keydown', (e) => {
  if (!slashMenu.classList.contains('hidden')) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = (slashIdx + 1) % slashItems.length; paintSlashSel(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = (slashIdx - 1 + slashItems.length) % slashItems.length; paintSlashSel(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); execSlash(slashItems[slashIdx]); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); busy ? steer() : send(); return; }
  // Esc interrupts a running turn (every harness: Esc = abort)
  if (e.key === 'Escape' && busy) { e.preventDefault(); abort(); return; }
  // ArrowUp on an empty composer recalls the last user message for edit-resend
  if (e.key === 'ArrowUp' && !input.value.trim() && lastUserText) {
    e.preventDefault(); input.value = lastUserText; autogrow(); return;
  }
});
/* Ctrl+K / Ctrl+P — command palette over sessions + slash commands */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    input.value = '/'; autogrow(); slashFilter();
    input.focus();
  }
});
/* prompt queue — messages sent while a run is active wait as chips above
 * the composer; agent_end flushes the next one. "立即转向" = steer now. */
const queue = [];
function renderQueue() {
  const row = $('queue-row');
  row.innerHTML = '';
  row.classList.toggle('hidden', queue.length === 0);
  queue.forEach((q, i) => {
    const chip = document.createElement('div');
    chip.className = 'q-chip';
    chip.innerHTML = `<span class="q-text"></span><button class="q-btn" title="立即转向发送">转向</button><button class="q-x" title="移除">×</button>`;
    const label = q.label ?? q.text;
    chip.querySelector('.q-text').textContent = label.length > 60 ? `${label.slice(0, 60)}…` : label;
    chip.querySelector('.q-btn').onclick = async () => {
      queue.splice(i, 1); renderQueue();
      const r = await cmd('steer', { message: q.text });
      if (!r.success) addSys(`插话失败：${r.error ?? '未知'}`, true);
    };
    chip.querySelector('.q-x').onclick = () => { queue.splice(i, 1); renderQueue(); };
    row.appendChild(chip);
  });
}
function flushQueue() {
  const next = queue.shift();
  renderQueue();
  if (!next) return;
  lastUserText = next.label ?? next.text;
  addMsg('user', next.label ?? next.text);
  cmd('prompt', { message: next.text, ...(next.attachments?.length ? { options: { attachments: next.attachments } } : {}) }).then((r) => {
    if (!r.success) addSys(`发送失败：${r.error ?? '未知'}`, true);
  });
}
/* @path mentions resolve to real file content before the prompt leaves —
   the model receives the text, not just a path it must then go read. */
async function expandAtMentions(text) {
  const tokens = [...text.matchAll(/@([\w./\\-]+)/g)].map((m) => m[1]);
  if (!tokens.length) return { text, attached: [], missed: [] };
  const attached = [], missed = [];
  const blocks = [];
  for (const rel of [...new Set(tokens)]) {
    const r = await cmd('file_read', { path: rel });
    if (r.success && r.data?.content != null) {
      attached.push(rel);
      blocks.push(`\n\n<attached path="${rel}">\n${r.data.content}\n</attached>`);
      continue;
    }
    // @folder: directory mention expands to a bounded listing block — the
    // model sees the tree shape, not a fake file dump
    const dirName = rel.replace(/[\\/]+$/, '');
    const d = await cmd('files_list', { prefix: dirName });
    const dirFiles = (d.data?.files ?? []).filter((f) => f === dirName || f.startsWith(dirName + '/'));
    if (dirFiles.length) {
      attached.push(rel);
      blocks.push(`\n\n<folder path="${dirName}/">\n${dirFiles.slice(0, 200).join('\n')}\n</folder>`);
    } else missed.push(rel);
  }
  return { text: text + blocks.join(''), attached, missed };
}
/* ---------- recipes: .pai/recipes/<name>.md parameterized task packages ---------- */
// Thin Goose-recipe analogue: frontmatter declares description + params
// (`params: a(required), b=default`), body carries {{param}} placeholders.
// Files come through file_read/files_list so .paiignore exclusions apply.
async function loadRecipes() {
  const l = await cmd('files_list', { prefix: '.pai/recipes/' });
  const files = (l.data?.files ?? []).filter((f) => f.endsWith('.md'));
  const out = [];
  for (const f of files) {
    const r = await cmd('file_read', { path: f });
    if (!r.success || r.data?.content == null) continue;
    const m = r.data.content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const meta = m ? m[1] : '';
    const body = (m ? m[2] : r.data.content).trim();
    const description = meta.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const paramsRaw = meta.match(/^params:\s*(.+)$/m)?.[1] ?? '';
    const params = paramsRaw.split(',').map((s) => s.trim()).filter(Boolean).map((p) => {
      const req = p.match(/^(\w+)\(required\)$/);
      if (req) return { name: req[1], required: true };
      const d = p.match(/^(\w+)=(.*)$/);
      if (d) return { name: d[1], default: d[2] };
      return { name: p, required: true };
    });
    out.push({ name: f.replace(/^\.pai\/recipes\//, '').replace(/\.md$/, ''), description, params, body });
  }
  return out;
}

/* ---------- attachments: paste/drop files + images into the composer ---------- */
// Browser File API reads the bytes locally — no server-side path access, so
// files from ANYWHERE (not just the workdir) can be attached. Text files land
// inline as labeled blocks; images ride prompt options as ImageContent.
const pendingAttach = []; // {name, kind:'text'|'image'|'media', text?, data?, mimeType?, bytes}
const pendingBash = []; // {command, output} — `!cmd` results joining the next prompt
const ATTACH_MAX = 512 * 1024;
function renderAttach() {
  const row = $('attach-row');
  if (!row) return;
  row.classList.toggle('hidden', pendingAttach.length === 0);
  row.innerHTML = '';
  pendingAttach.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.innerHTML = `<span class="attach-name"></span><button class="attach-x" title="移除">✕</button>`;
    chip.querySelector('.attach-name').textContent = `${a.kind === 'image' ? '🖼' : '📄'} ${a.name} (${Math.round(a.bytes / 1024)}KB)`;
    chip.querySelector('.attach-x').onclick = () => { pendingAttach.splice(i, 1); renderAttach(); };
    row.appendChild(chip);
  });
}
async function attachFiles(fileList) {
  for (const f of fileList ?? []) {
    if (f.size > ATTACH_MAX) { toast(`${f.name} 超过 512KB，未附着`, 'err'); continue; }
    if (f.type.startsWith('image/') || /^(audio|video)\//.test(f.type)
        || (!f.type.startsWith('text/') && !/\.(md|txt|json|js|ts|py|java|c|cpp|h|css|html|xml|ya?ml|toml|csv|log|sh|bat|ps1|sql)$/i.test(f.name))) {
      // Binary + media: carry as base64 MediaAttachment — the channel maps it
      // by body capability (images native, the rest a truthful descriptor).
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      pendingAttach.push({ name: f.name, kind: f.type.startsWith('image/') ? 'image' : 'media', data: btoa(bin), mimeType: f.type || 'application/octet-stream', bytes: f.size });
    } else {
      const text = await f.text();
      pendingAttach.push({ name: f.name, kind: 'text', text, bytes: f.size });
    }
  }
  renderAttach();
}
input.addEventListener('paste', (e) => {
  if (e.clipboardData?.files?.length) { e.preventDefault(); attachFiles(e.clipboardData.files); return; }
  // Codex long-paste analogue: a wall of pasted text becomes an attachment
  // chip instead of flooding the composer — same 'text' kind as file drops,
  // sent as an inline labeled block.
  const t = e.clipboardData?.getData?.('text/plain') ?? '';
  if (t.length > 1500) {
    e.preventDefault();
    pendingAttach.push({ name: `粘贴文本-${new Date().toTimeString().slice(0, 8).replaceAll(':', '')}.txt`, kind: 'text', text: t, bytes: t.length });
    renderAttach();
  }
});
const composerEl = $('composer');
composerEl.addEventListener('dragover', (e) => { e.preventDefault(); composerEl.classList.add('drop'); });
composerEl.addEventListener('dragleave', () => composerEl.classList.remove('drop'));
composerEl.addEventListener('drop', (e) => {
  e.preventDefault(); composerEl.classList.remove('drop');
  attachFiles(e.dataTransfer?.files);
});

async function send() {
  const text = input.value.trim();
  if (!text && !pendingAttach.length) return;
  closeSlash();
  input.value = ''; autogrow();
  localStorage.removeItem(draftKey());
  // `!cmd` — operator direct-exec (Claude Code bang mode): runs through the
  // governed decide chain (ask rules still pop approval cards); the output
  // is stashed and prepended to the NEXT prompt so the model sees it.
  if (text.startsWith('!') && !pendingAttach.length) {
    const command = text.slice(1).trim();
    if (!command) { addSys('! 后面要跟要执行的命令', true); return; }
    addMsg('user', text);
    const r = await cmd('bash_run', { command });
    if (!r.success) addSys(`执行不可用：${r.error ?? '未知'}`, true);
    else if (r.data?.blocked) addSys(`已拦截：${(r.data.reason ?? '').slice(0, 300)}`, true);
    else if (r.data) pendingBash.push({ command, output: r.data.output ?? '' });
    return;
  }
  // `#note` — quick-capture into long-term memory (Claude Code hash mode).
  if (text.startsWith('#') && !pendingAttach.length) {
    const note = text.slice(1).trim();
    if (!note) { addSys('# 后面要跟要记住的内容', true); return; }
    const r = await cmd('memory_save', { text: note, kind: 'fact' });
    addSys(r.success ? `已记住：${note.slice(0, 80)}` : `记忆失败：${r.error ?? '未知'}`, !r.success);
    return;
  }
  // Fold pending attachments into the outgoing prompt: text → labeled block,
  // images → PromptOptions.images (pi prompt accepts {images: ImageContent[]}).
  let message = text;
  const attachCount = pendingAttach.length;
  const attachments = [];
  for (const a of pendingAttach.splice(0)) {
    if (a.kind === 'text') message += `\n\n<file name="${a.name}">\n${a.text}\n</file>`;
    else attachments.push({ name: a.name, mime: a.mimeType, data: a.data, bytes: a.bytes });
  }
  // `!cmd` outputs the operator ran since the last prompt ride into context
  if (pendingBash.length) {
    const blk = pendingBash.splice(0)
      .map((b) => `<operator-bash command="${b.command.slice(0, 200)}">\n${b.output.slice(0, 4000)}\n</operator-bash>`)
      .join('\n');
    message = `${blk}\n\n${message}`;
  }
  renderAttach();
  if (busy) { queue.push({ text: message, attachments, label: text || `（${attachCount} 个附件）` }); renderQueue(); return; }
  lastUserText = text;
  addMsg('user', text || `（${attachCount} 个附件）`);
  const ex = await expandAtMentions(message);
  if (ex.attached.length) addSys(`已附着 ${ex.attached.length} 个文件：${ex.attached.join('、')}`);
  if (ex.missed.length) addSys(`未能读取：${ex.missed.join('、')}（请确认路径在 workdir 内）`, true);
  const r = await cmd('prompt', { message: ex.text, ...(attachments.length ? { options: { attachments } } : {}) });
  if (!r.success) addSys(`发送失败：${r.error ?? '未知'}`, true);
}
async function steer() {
  const text = input.value.trim();
  if (!text) return;
  closeSlash();
  input.value = ''; autogrow();
  localStorage.removeItem(draftKey());
  const r = await cmd('steer', { message: text });
  if (!r.success) addSys(`插话失败：${r.error ?? '未知'}`, true);
}
$('send').onclick = () => (busy ? steer() : send());
$('steer').onclick = steer;
for (const b of document.querySelectorAll('.starter')) {
  b.onclick = () => { input.value = b.dataset.q; autogrow(); input.focus(); };
}
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
es.onerror = () => {
  setStatus('连接断开，重试中…', 'err');
  const ss = $('splash-status');
  if (ss && !$('splash')?.classList.contains('done')) ss.textContent = '连接断开，重试中…';
};
es.onopen = () => {
  setStatus('就绪');
  refreshPending(); // asks raised while disconnected are still live
  // splash is honest: it covers only the real connect wait, no fake progress
  const sp = $('splash');
  if (sp && !sp.classList.contains('done')) {
    sp.classList.add('done');
    setTimeout(() => sp.remove(), 450);
  }
};

/* chat column width drag — Codex resize handle analogue; --chat-w is the
   single var every centered row already keys off */
{
  const h = $('chatw-handle');
  const savedW = Number(localStorage.getItem('pai.chatW'));
  if (savedW >= 480 && savedW <= 1400) document.documentElement.style.setProperty('--chat-w', `${savedW}px`);
  h?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    h.classList.add('drag');
    h.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const center = $('view-chat').getBoundingClientRect().left + $('view-chat').offsetWidth / 2;
      const w = Math.min(1400, Math.max(480, Math.round((ev.clientX - center) * 2)));
      document.documentElement.style.setProperty('--chat-w', `${w}px`);
    };
    const up = () => {
      h.classList.remove('drag');
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      localStorage.setItem('pai.chatW', getComputedStyle(document.documentElement).getPropertyValue('--chat-w').replace('px', ''));
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  });
}

autogrow();
(async () => {
  await refreshAll();
  await replayHistory(); // reopened app should show the persisted session, not blank
  await refreshPending();
})();

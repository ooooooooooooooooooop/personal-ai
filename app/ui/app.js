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

/* Minimal text-input modal — window.prompt() throws in Electron renderers,
 * so every rename/import/memory flow needs a DOM dialog. */
function askText(title, placeholder = '', value = '') {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal-ov';
    ov.innerHTML = `<div class="modal"><div class="modal-title"></div><input class="modal-input" type="text" spellcheck="false" /><div class="modal-foot"><button class="btn ghost modal-cancel">取消</button><button class="btn modal-ok">确定</button></div></div>`;
    ov.querySelector('.modal-title').textContent = title;
    const inp = ov.querySelector('.modal-input');
    inp.placeholder = placeholder;
    inp.value = value;
    const done = (v) => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      else if (e.key === 'Enter') { e.stopPropagation(); done(inp.value.trim() || null); }
    };
    ov.querySelector('.modal-ok').onclick = () => done(inp.value.trim() || null);
    ov.querySelector('.modal-cancel').onclick = () => done(null);
    ov.onclick = (e) => { if (e.target === ov) done(null); };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(ov);
    inp.focus();
    inp.select();
  });
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
  try {
    const res = await fetch('/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `u${++cmdSeq}`, type, ...params }),
    });
    return await res.json();
  } catch (e) {
    // Bridge unreachable / response unreadable — surface it like any backend
    // error instead of an unhandled rejection that kills the handler silently.
    return { id: null, type: 'response', command: type, success: false, error: `桥连接失败：${e?.message ?? e}` };
  }
}

/* ---------- scroll follow: three-mode persisted preference (M128) ----------
   near   — follow only while the user sits at the tail (classic behaviour)
   always — every append pins to the bottom, even after the user scrolled up
   off    — never auto-scroll; the jump button still works on demand        */
const transcript = $('transcript');
const SCROLL_KEY = 'pai.scrollmode';
function scrollMode() { return localStorage.getItem(SCROLL_KEY) ?? 'near'; }
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
  const mode = scrollMode();
  if (mode === 'always') { transcript.scrollTop = transcript.scrollHeight; return; }
  if (mode === 'off' || !nearBottom) { if (sawMessage) $('jump-latest').classList.add('show'); return; }
  transcript.scrollTop = transcript.scrollHeight;
}
$('jump-latest').onclick = () => {
  nearBottom = true;
  $('jump-latest').classList.remove('show');
  transcript.scrollTop = transcript.scrollHeight;
};

/* ---------- M109: transcript selection → "引用到对话" floating button ---------- */
const selQuoteBtn = $('sel-quote');
let selQuoteText = '';
function hideSelQuote() { selQuoteBtn.classList.add('hidden'); selQuoteText = ''; }
function updateSelQuote() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !String(sel).trim()) { hideSelQuote(); return; }
  const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
  if (!anchor || !transcript.contains(anchor)) { hideSelQuote(); return; }
  selQuoteText = String(sel).trim();
  const r = sel.getRangeAt(0).getBoundingClientRect();
  selQuoteBtn.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - 55), window.innerWidth - 130)}px`;
  selQuoteBtn.style.top = `${Math.max(8, r.top - 38)}px`;
  selQuoteBtn.classList.remove('hidden');
}
document.addEventListener('mouseup', () => setTimeout(updateSelQuote, 0));
document.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') updateSelQuote(); });
document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed) hideSelQuote(); });
transcript.addEventListener('scroll', hideSelQuote);
// mousedown must not collapse the selection before click fires
selQuoteBtn.addEventListener('mousedown', (e) => e.preventDefault());
selQuoteBtn.onclick = () => {
  if (!selQuoteText) return;
  const quote = selQuoteText.split('\n').map((l) => `> ${l}`).join('\n');
  pushDraft();
  const cur = input.value.replace(/\n+$/, '');
  input.value = `${cur ? `${cur}\n\n` : ''}${quote}\n\n`;
  prevDraft = input.value;
  hideSelQuote(); autogrow(); input.focus();
};
document.addEventListener('mousedown', (e) => { if (e.target !== selQuoteBtn) hideSelQuote(); });

/* Keep transcript bottom padding in sync with composer-dock height so no ask card / message is obscured */
const composerDock = $('composer-dock');
if (composerDock && transcript) {
  const syncTranscriptPadding = () => {
    const dockH = composerDock.offsetHeight || 140;
    transcript.style.paddingBottom = `${dockH + 28}px`;
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncTranscriptPadding).observe(composerDock);
  }
  syncTranscriptPadding();
}

/* ---------- minimal markdown (safe: escape first, then structure) ---------- */
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeHtml = (s) => (s ? escHtml(String(s)) : '');
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
    $('empty-state')?.classList.add('hidden'); // keep the node — a fresh session re-shows it
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
      pushDraft(); input.value = r2.data?.editorText ?? myText;
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
// project trust (Pi trust.json analogue): repo-planted .pai/microagents are
// silent prompt injection — they only activate after an operator trust grant.
// Banner once per workdir per app run; grant persists in instance state.
const trustChecked = new Set();
async function checkProjectTrust() {
  const r = await cmd('project_trust_status');
  const d = r.data ?? {};
  if (!r.success || !d.hasInjectableContent || d.trusted) return;
  const key = state?.workdir ?? 'wd';
  if (trustChecked.has(key)) return;
  trustChecked.add(key);
  const div = document.createElement('div');
  div.className = 'trust-card';
  div.innerHTML = `
    <div class="trust-head">
      <svg class="trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <span class="trust-title">本地规则自动注入已就绪</span>
    </div>
    <div class="trust-body">检测到此目录的 <code>.pai/microagents</code> 包含上下文规则，需经您授权方可注入会话。</div>
    <div class="trust-foot">
      <button type="button" class="btn sm trust-ok">信任并启用</button>
      <button type="button" class="btn ghost sm trust-dismiss">暂不注入</button>
    </div>
  `;
  div.querySelector('.trust-ok').onclick = async () => {
    const g = await cmd('project_trust_set', { trusted: true });
    if (g.success) { toast('已信任此项目规则'); div.remove(); }
    else addSys(`信任失败：${g.error ?? '未知'}`, true);
  };
  div.querySelector('.trust-dismiss').onclick = () => {
    div.remove();
  };
  transcript.appendChild(div);
  scrollTail();
}

function clearTranscript() {
  transcript.querySelectorAll('.msg,.sys,.tool,.think-row,.handoff-card,.trust-card,.session-recap').forEach((n) => n.remove());
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
    const parts = [];
    const t = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
    if (t) parts.push(t);
    // M115: non-text blocks (image/resource) reach the model but used to
    // silently vanish here. Render a bounded descriptor instead — the URI is
    // shown as text, never auto-loaded.
    for (const b of blocks) {
      if (!b || b.type === 'text') continue;
      const mime = b.mimeType ?? b.resource?.mimeType ?? '';
      const label = b.name ?? b.resource?.name ?? b.resource?.uri ?? '';
      parts.push(`[${b.type}${mime ? ` ${mime}` : ''}${label ? `: ${label}` : ''}]`);
    }
    if (parts.length) return parts.join('\n');
  }
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}
/* media descriptor → one-line label for replayed history (M115) */
function mediaLabel(md) {
  return `[${md.type}${md.mimeType ? ` ${md.mimeType}` : ''}${md.name ? `: ${md.name}` : ''}]`;
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
  panel.innerHTML = `<button class="todo-head" type="button"><span class="t-caret">${CARET}</span><span class="todo-title">任务清单</span><span class="todo-badge">${done}/${todos.length}</span></button><div class="todo-items"></div>`;
  const items = panel.querySelector('.todo-items');
  for (const t of todos) {
    const row = document.createElement('div');
    row.className = `todo-item ${t.status === 'in_progress' ? 'doing' : t.status === 'completed' ? 'done' : ''}`;
    const icon = t.status === 'completed'
      ? `<svg class="todo-svg done" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z"/></svg>`
      : t.status === 'in_progress'
        ? `<span class="todo-dot doing" aria-hidden="true"></span>`
        : `<span class="todo-dot" aria-hidden="true"></span>`;
    row.innerHTML = `<span class="todo-box">${icon}</span><span class="todo-text"></span>`;
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
    if (t) t.textContent = `处理中 · ${Math.round((Date.now() - procStart) / 1000)}s${turnTools ? ` · ${turnTools} 工具` : ''}`;
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

/**
 * Unattended escalation: ask timeout is auto-deny, so a missed ask = stalled
 * work. The in-window beep dies with focus; an OS notification reaches the
 * operator when the app is minimized. Best-effort — never blocks the card.
 */
function notifyAsk(ask) {
  try {
    if (!('Notification' in window)) return;
    if (!document.hidden) return; // focused: card + beep already has them
    if (Notification.permission === 'default') { Notification.requestPermission(); return; }
    if (Notification.permission !== 'granted') return;
    const n = new Notification('需要审批（超时将自动拒绝）', {
      body: `${ask.toolName ?? '工具'}：${String(ask.summary ?? '').slice(0, 140)}`,
      silent: true, // the beep already rang
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* notification is an escalation nicety, not a gate */ }
}

function addAskCard(ask) {
  if (!ask?.id || askCards.has(ask.id)) return;
  noteMessage();
  beep(1040, 0.15); // approval gate = attention request — ring even when focused
  notifyAsk(ask);
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
    <div class="ask-advice"></div>
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
  // P3 shadow judge: second opinion, clearly marked as advisory — it can
  // never flip the verdict; the human still owns the buttons.
  const adv = div.querySelector('.ask-advice');
  if (ask.advisory?.suggest) {
    adv.textContent = `顾问参考·风险 ${ask.advisory.risk} · 建议${ask.advisory.suggest === 'deny' ? '拒绝' : '允许'}：${ask.advisory.why || '（无说明）'}`;
    adv.classList.add(ask.advisory.suggest === 'deny' ? 'advice-deny' : 'advice-allow');
  } else adv.remove();
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
  if (ask.argsRedacted) {
    // M116: secrets in the payload are masked before reaching the DOM —
    // tell the operator the card hides credential material on purpose.
    payload.insertAdjacentHTML('beforeend',
      `<div class="ask-trunc">载荷中的凭据/密钥已遮蔽（[REDACTED]）——批准/拒绝仍作用于完整参数</div>`);
  }
  if (ask.args && typeof ask.args === 'object') {
    const cmdStr = ask.args.command ?? ask.args.cmd;
    const editPair = [ask.args.oldText ?? ask.args.old_string, ask.args.newText ?? ask.args.new_string];
    if (cmdStr) {
      payload.insertAdjacentHTML('beforeend', `<pre class="ask-cmd"></pre><textarea class="ask-edit hidden" spellcheck="false"></textarea><button class="ask-edit-toggle" type="button">编辑命令</button>`);
      payload.querySelector('.ask-cmd').textContent = `$ ${cmdStr}`;
      // edit-then-approve (CodeBuddy/Claude): the card can carry the
      // operator's corrected command — the edited text replaces the args,
      // never bypasses governance for other layers (deny-prefix, protected
      // paths still apply to the edited command).
      const editBox = payload.querySelector('.ask-edit');
      editBox.value = String(cmdStr);
      const tog = payload.querySelector('.ask-edit-toggle');
      tog.onclick = () => {
        const on = editBox.classList.toggle('hidden');
        tog.textContent = on ? '编辑命令' : '收起编辑';
        if (!on) editBox.focus();
      };
      div._editedCommand = () => {
        const v = editBox.value;
        return v !== String(cmdStr) ? v : null;
      };
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
  } else if (ask.kind === 'form') {
    // Structured-input card (dedup-h #33): the ask carries a field schema;
    // render labeled controls per field and resolve to a values object.
    // The host re-validates the object — this card is only the renderer.
    div.querySelector('.ask-title').textContent = ask.summary || '需要填写信息';
    const foot = div.querySelector('.ask-foot');
    foot.innerHTML = '';
    foot.classList.add('ask-question');
    const inputs = {};
    for (const f of ask.fields ?? []) {
      const row = document.createElement('label');
      row.className = 'ask-field';
      const cap = document.createElement('span');
      cap.className = 'ask-field-label';
      cap.textContent = `${f.label ?? f.key}${f.required ? ' *' : ''}`;
      if (f.description) cap.title = f.description;
      row.appendChild(cap);
      let el;
      if (f.type === 'boolean') {
        el = document.createElement('input');
        el.type = 'checkbox';
        el.checked = f.default === true;
      } else if (f.type === 'select') {
        el = document.createElement('select');
        for (const o of f.options ?? []) {
          const op = document.createElement('option');
          op.value = o; op.textContent = o;
          if (o === f.default) op.selected = true;
          el.appendChild(op);
        }
      } else if (f.type === 'textarea') {
        el = document.createElement('textarea');
        el.rows = 3;
        if (f.default != null) el.value = String(f.default);
      } else {
        el = document.createElement('input');
        // 'secret' fields (credential_request) render masked — the value
        // leaves with the answer and is never re-displayed anywhere.
        el.type = f.type === 'number' ? 'number' : f.type === 'secret' ? 'password' : 'text';
        if (f.type === 'secret') el.autocomplete = 'off';
        if (f.default != null) el.value = String(f.default);
      }
      el.dataset.key = f.key;
      row.appendChild(el);
      foot.appendChild(row);
      inputs[f.key] = { el, type: f.type };
    }
    const submitBtn = document.createElement('button');
    submitBtn.className = 'ask-btn primary';
    submitBtn.textContent = '提交';
    submitBtn.onclick = async () => {
      const values = {};
      for (const [k, { el, type }] of Object.entries(inputs)) {
        values[k] = type === 'boolean' ? el.checked : (type === 'number' && el.value !== '' ? Number(el.value) : el.value);
      }
      foot.querySelectorAll('button,input,select,textarea').forEach((x) => { x.disabled = true; });
      const r = await cmd('decision_resolve', { askId: ask.id, answer: values });
      if (!r.success) {
        foot.querySelectorAll('button,input,select,textarea').forEach((x) => { x.disabled = false; });
        addSys(`表单提交失败：${r.error ?? '未知'}`, true);
      }
    };
    foot.appendChild(submitBtn);
  } else {
  div.querySelectorAll('.ask-btn').forEach((b) => {
    b.onclick = async () => {
      div.querySelectorAll('.ask-btn').forEach((x) => { x.disabled = true; });
      let answer = b.dataset.a;
      // edited-command approvals carry the operator's text; only allow-family
      // answers may carry edits (deny+edit is meaningless)
      const editedCmd = div._editedCommand?.();
      const argKey = ask.args?.command != null ? 'command' : 'cmd';
      if (editedCmd != null && answer !== 'deny') {
        answer = { answer, edited: { [argKey]: editedCmd } };
      }
      const r = await cmd('decision_resolve', { askId: ask.id, answer });
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
    for (const md of m.media ?? []) addSys(`媒体块 ${mediaLabel(md)}`);
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
    const mediaTail = (m.media ?? []).map(mediaLabel).join('\n');
    const out = (m.text ?? '') + (mediaTail ? `${m.text ? '\n' : ''}${mediaTail}` : '');
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
let turnStart = 0;   // agent_start timestamp — for the turn-end summary line
let turnTools = 0;   // tool_execution_start count within the active turn

/* Prompt history (Crush 200-cap analogue): sent prompts persist across
 * restarts; ArrowUp/Down on an empty composer walks back/forward. */
const PROMPT_HIST_KEY = 'pai.prompt_hist';
const PROMPT_HIST_CAP = 200;
let promptHist = [];
try { promptHist = JSON.parse(localStorage.getItem(PROMPT_HIST_KEY) ?? '[]'); } catch { promptHist = []; }
let histIdx = -1; // -1 = not navigating; 0..n-1 = depth into history
function histPush(text) {
  if (!text || promptHist[promptHist.length - 1] === text) return;
  promptHist.push(text);
  if (promptHist.length > PROMPT_HIST_CAP) promptHist = promptHist.slice(-PROMPT_HIST_CAP);
  try { localStorage.setItem(PROMPT_HIST_KEY, JSON.stringify(promptHist)); } catch { /* quota */ }
  histIdx = -1;
}

/* notification drawer — bounded log behind the bell */
const notifyLog = [];
let unreadNotify = 0;
// M69 notify policy (Codex/Goose analogue): how loud model→operator
// notifications are. 'always' = toast+transcript+drawer; 'smart' = errors
// toast, warns transcript-only, info drawer-silent; 'never' = drawer only.
const NOTIFY_POLICY_KEY = 'pai.notifyPolicy';
function notifyPolicy() {
  const v = localStorage.getItem(NOTIFY_POLICY_KEY);
  return ['always', 'smart', 'never'].includes(v) ? v : 'always';
}
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
  const policyRow = `<div class="bell-head"><div class="bell-title">通知中心</div><div class="bell-policy"><label for="notify-policy" class="bell-policy-label">提醒策略</label><select id="notify-policy" class="bell-select">
    <option value="always">总是提醒</option><option value="smart">智能提醒</option><option value="never">静默模式</option>
  </select></div></div>`;
  d.innerHTML = policyRow + (notifyLog.length
    ? notifyLog.map((n) => `<div class="bell-row ${n.level === 'err' ? 'err' : ''}"><span class="bell-time"></span><span class="bell-msg"></span></div>`).join('')
    : '<div class="bell-empty"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg><div>暂无新通知</div><div class="bell-empty-sub">后台警报与长任务完成通知将在此汇总</div></div>');
  const sel = d.querySelector('#notify-policy');
  sel.value = notifyPolicy();
  sel.onchange = () => localStorage.setItem(NOTIFY_POLICY_KEY, sel.value);
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
      turnStart = Date.now();
      turnTools = 0;
      startProc();
      break;
    case 'message_start':
      if (ev.message?.role === 'assistant') { assistantEl = addMsg('assistant', ''); thinkEl = null; }
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
    case 'scheduled_job_done': {
      // M14: a scheduled job's completion delivered to the operator surface —
      // toast + notification drawer + a transcript line with the output tail.
      const ok = ev.exit_code === 0;
      const msg = `定时任务 ${ev.job_id} ${ok ? '完成' : `失败(exit ${ev.exit_code})`}`;
      toast(msg, ok ? 'info' : 'err');
      notifyLog.unshift({ message: msg, level: ok ? 'info' : 'err', at: Date.now() });
      if (notifyLog.length > 50) notifyLog.pop();
      paintBell?.();
      addSys(`${msg}${ev.output_tail ? `\n${ev.output_tail.slice(-800)}` : ''}`, !ok);
      refreshSchedules?.();
      refreshJobs?.();
      break;
    }
    case 'notify': {
      // notify_user: model→operator one-way notification (Kimi NotifyUser).
      // Policy gates the LOUDNESS, never the record — the drawer keeps every
      // notification regardless of 'never'/'smart'.
      const lvl = ev.level ?? 'info';
      const pol = notifyPolicy();
      if (pol === 'always' || (pol === 'smart' && lvl === 'err')) {
        toast(ev.message, lvl === 'err' ? 'err' : 'info');
        addSys(`通知：${ev.message}`, lvl === 'err');
      } else if (pol === 'smart' && lvl === 'warn') {
        addSys(`通知：${ev.message}`, false);
      }
      // notification drawer (PI-Desktop notification center analogue):
      // toasts are transient — this keeps the last 50 for recall
      notifyLog.unshift({ message: ev.message, level: lvl, at: Date.now() });
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
      turnTools++;
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
      addSys(`预算超限——会话已停止：${ev.rule} ${ev.consumed} ≥ ${ev.limit}（上限来自规范策略/操作员环境，模型不能自行放宽）
恢复：左侧「新建任务」开新会话即重置本会话用量；要更高上限去「设置 → 预算上限」调`, true);
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
      turnStart = 0; // don't attribute a summary across the switch
      loadDraft();
      checkProjectTrust();
      replayHistory();
      refreshSessions();
      refreshPending();
      refreshState();
      refreshMode(); // plan/act is session-scoped — chip must follow the switch
      refreshTodos();
      break;
    case 'agent_end':
      setBusy(false);
      if (document.hidden) beep(660, 0.18); // turn done while away — call the operator back
      assistantEl = null;
      thinkEl = null;
      // ZCode turn-end summary: duration + tool-call count for the finished turn
      if (turnStart) {
        const secs = ((Date.now() - turnStart) / 1000).toFixed(1);
        addSys(`本轮 ${secs}s · ${turnTools} 个工具调用`);
        turnStart = 0;
      }
      stopProc(true);
      actGroup?.classList.remove('open');
      actGroup = null;
      refreshState();
      refreshSessionsSoon();
      flushQueue();
      drainSessionCmds();
      break;
    case 'command_request':
      // dedup-h #143: model-invoked builtin commands — queued until the turn
      // ends, then run through the same code paths as operator slash commands.
      queueSessionCommand(ev.name, ev.arg);
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
  } else if (ev.kind === 'body_respawn_wait') {
    setStatus(`身体崩溃，${Math.round((ev.inMs ?? 1000) / 1000)}s 后自动重启（第 ${ev.attempt} 次）…`, 'err');
  } else if (ev.kind === 'body_respawned') {
    setStatus('就绪');
    addSys(`身体 ${ev.body} 崩溃后已自动重启（第 ${ev.attempt} 次尝试）`);
    refreshAll();
  } else if (ev.kind === 'body_respawn_failed') {
    setStatus('身体重启失败', 'err');
    addSys(`身体自动重启失败（第 ${ev.attempt} 次）：${ev.error ?? '未知'}——请重启应用`, true);
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
  // Sweep affordance: archive candidates = unpinned sessions idle >14d
  // (ZCode auto-archive analogue — operator-triggered, always reversible).
  const sweepable = sessionsCache.filter((s) => !s.pinned && !s.archived
    && Date.parse(s.modified ?? s.created ?? '') < Date.now() - 14 * 86400_000);
  if (sweepable.length) {
    const t = document.createElement('button');
    t.className = 'sess-arch-toggle';
    t.textContent = `归档 ${sweepable.length} 个 14 天前的旧会话`;
    t.onclick = async () => {
      const r = await cmd('session_sweep', { days: 14 });
      if (r.success) { toast(`已归档 ${r.data?.swept ?? 0} 个旧会话`); await refreshSessions(); }
      else addSys(`归档清扫失败：${r.error ?? '未知'}`, true);
    };
    box.appendChild(t);
  }
  // Bulk-delete archived sessions (ZCode archived-bulk-delete analogue).
  // Irreversible — explicit confirm; pinned sessions are never purged.
  const purged = sessionsCache.filter((s) => s.archived && !s.pinned);
  if (showArchived && purged.length) {
    const t = document.createElement('button');
    t.className = 'sess-arch-toggle danger';
    t.textContent = `永久删除 ${purged.length} 个已归档会话`;
    t.onclick = async () => {
      if (!confirm(`永久删除 ${purged.length} 个已归档会话？此操作不可撤销。`)) return;
      const r = await cmd('session_purge');
      if (r.success) { toast(`已删除 ${r.data?.purged ?? 0} 个归档会话`); await refreshSessions(); }
      else addSys(`批量删除失败：${r.error ?? '未知'}`, true);
    };
    box.appendChild(t);
  }
  // session import (Cursor/Claude import-session): bring a foreign .jsonl
  // session into the store — lands in the list as [导入] name, no switch.
  {
    const t = document.createElement('button');
    t.className = 'sess-arch-toggle';
    t.textContent = '导入会话文件…';
    t.onclick = async () => {
      const p = await askText('导入会话', '会话文件完整路径（.jsonl）');
      if (!p?.trim()) return;
      const r = await cmd('session_import', { path: p.trim() });
      if (r.success) { toast(`已导入：${r.data?.name ?? '会话'}`); await refreshSessions(); }
      else addSys(`导入失败：${r.error ?? '未知'}`, true);
    };
    box.appendChild(t);
  }
  const groups = new Map();
  // C1: pinned sessions form their own leading group instead of merely
  // sorting to the top inside each date bucket.
  const pinnedRows = items.filter((s) => s.pinned);
  if (pinnedRows.length) groups.set('📌 置顶', pinnedRows);
  for (const s of items) {
    if (s.pinned) continue;
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
      const typeTag = s.type === 'teammate' ? '👥 ' : s.type === 'subagent' ? '↳ ' : '';
      const rawTitle = s.name || s.firstMessage;
      const cleanTitle = (!rawTitle || rawTitle.trim() === '(no messages)') ? '新对话' : rawTitle;
      const title = `${typeTag}${cleanTitle}`;
      row.innerHTML = `<span class="sess-dot"></span><span class="sess-title"></span><span class="sess-meta">${s.pinned ? '📌 ' : ''}${s.messageCount ?? 0} 条</span>`;
      row.querySelector('.sess-title').textContent = title.length > 40 ? `${title.slice(0, 40)}…` : title;
      // C1 status dot: live = task-bound session still running, or the open
      // session mid-turn. Archived gets a hollow dot; plain sessions get
      // none — 完成/未完成 isn't derivable without reading transcript tails,
      // so we don't fake it.
      const dot = row.querySelector('.sess-dot');
      const live = s.live || (s.path === currentSessionFile && busy);
      if (live) { dot.classList.add('live'); dot.title = '进行中'; }
      else if (s.archived) { dot.classList.add('arch'); dot.title = '已归档'; }
      const hit = searchHits?.get(s.path);
      if (hit?.length && !`${s.name ?? ''} ${s.firstMessage ?? ''}`.toLowerCase().includes(filter)) {
        const snip = document.createElement('div');
        snip.className = 'sess-snip';
        snip.textContent = hit[0];
        row.appendChild(snip);
      }
      // C1 hover card: native title can't carry structured metadata —
      // show cwd, timestamps, count and flags after a short hover delay.
      let cardTimer = 0;
      const hideCard = () => { $('sess-card')?.remove(); };
      row.addEventListener('mouseenter', () => {
        cardTimer = setTimeout(() => {
          hideCard();
          const c = document.createElement('div');
          c.id = 'sess-card';
          c.innerHTML = '<div class="sc-title"></div><div class="sc-line"></div><div class="sc-line"></div><div class="sc-line dim"></div>';
          const fmt = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');
          c.children[0].textContent = cleanTitle;
          const flags = [s.type === 'teammate' ? '队友会话' : s.type === 'subagent' ? '子代理' : null,
            s.live || (s.path === currentSessionFile && busy) ? '进行中' : null,
            s.pinned ? '已置顶' : null, s.archived ? '已归档' : null].filter(Boolean).join(' · ');
          c.children[1].textContent = `${s.messageCount ?? 0} 条${flags ? ` · ${flags}` : ''}`;
          c.children[2].textContent = `修改 ${fmt(s.modified)} · 创建 ${fmt(s.created)}`;
          c.children[3].textContent = s.cwd || s.path;
          c.children[3].title = s.path;
          document.body.appendChild(c);
          const r = row.getBoundingClientRect();
          c.style.left = `${Math.min(r.right + 10, window.innerWidth - c.offsetWidth - 8)}px`;
          c.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - c.offsetHeight - 8))}px`;
        }, 400);
      });
      row.addEventListener('mouseleave', () => { clearTimeout(cardTimer); hideCard(); });
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
              const name = await askText('重命名会话', '会话名字', s.name || s.firstMessage || '');
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
  if (!r.success) {
    addSys(`切换会话失败：${r.error ?? '未知'}`, true);
  } else {
    currentSessionFile = path;
    await showRecap();
  }
  switchView('chat');
  await refreshState();
  renderSessions();
}
/* /recap analogue — on returning to a session, an extractive one-liner of
 * where it left off (first prompt + last user prompt + size). Local and
 * extractive by design: no model call, no invented summary. */
async function showRecap() {
  const r = await cmd('session_entries');
  const meta = sessionsCache.find((s) => s.path === currentSessionFile) ?? null;
  const entries = r.success ? (r.data ?? []) : [];
  const lastUser = entries.length ? String(entries[entries.length - 1].text ?? '').trim() : '';
  const first = String(meta?.firstMessage ?? '').trim();
  if (!lastUser && !first) return;
  const clip = (s) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
  const timeStr = meta?.modified ? meta.modified.slice(0, 16).replace('T', ' ') : '';
  const div = document.createElement('div');
  div.className = 'session-recap';
  div.innerHTML = `
    <div class="recap-title">断点恢复 · ${meta?.messageCount ?? 0} 条历史记录 ${timeStr ? `(${timeStr})` : ''}</div>
    ${lastUser ? `<div class="recap-prompt">上次提问：「${escapeHtml(clip(lastUser))}」</div>` : ''}
  `;
  $('transcript').appendChild(div);
  scrollTail();
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
// Per-model gating: a model without reasoning capability gets only 'off' —
// offering 极高 to a non-reasoning model writes a setting nothing honors.
function thinkLevelsForCurrent() {
  const cur = modelStatus?.current;
  if (cur && !cur.reasoning) return ['off'];
  return THINK_LEVELS;
}
$('thinking-chip').onclick = () => {
  if (!chipMenu.classList.contains('hidden')) { closeMenu(); return; }
  const levels = thinkLevelsForCurrent();
  const cur = modelStatus?.thinkingLevel ?? 'medium';
  const items = levels.map((lv) => ({
    label: `推理 · ${THINK_LABEL[lv]}`,
    sub: lv,
    current: lv === (levels.includes(cur) ? cur : 'off'),
    value: lv,
  }));
  if (levels.length === 1) items.push({ label: '当前模型不支持推理', sub: '', value: null });
  openMenu(items, async (it) => {
    if (!it.value) return;
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
  const levels = thinkLevelsForCurrent();
  const effLv = levels.includes(lv) ? lv : 'off';
  $('set-thinking').innerHTML = levels.map((l) => `<option value="${l}"${l === effLv ? ' selected' : ''}>${THINK_LABEL[l]}</option>`).join('');
  $('set-thinking').disabled = levels.length === 1;
  // Gate: no current model → setup card takes over the empty state
  const noModel = modelStatus?.current == null;
  $('setup-card')?.classList.toggle('hidden', sawMessage || !noModel);
  $('empty-state')?.classList.toggle('hidden', sawMessage || noModel);
  updateChips();
  refreshFallbacks(list.data ?? []);
}

/* 故障转移链接线（model_fallbacks/model_fallback_set）：链存实例级
 * model-fallbacks.json，loop 扩展在当前模型失败时按序回退。 */
let fallbackChain = [];
async function refreshFallbacks(models) {
  const list = $('fallback-list');
  if (!list) return;
  const r = await cmd('model_fallbacks');
  fallbackChain = r.success ? (r.data?.chain ?? []) : [];
  list.innerHTML = fallbackChain.length
    ? fallbackChain.map((e, i) => `<div class="set-row"><span class="pill">${i + 1}</span><code class="path-code" style="flex:1">${escHtml(e.provider)}/${escHtml(e.model)}</code><button class="ghost-btn fb-del" data-i="${i}">移除</button></div>`).join('')
    : '<div class="set-sub">未配置</div>';
  for (const b of list.querySelectorAll('.fb-del')) {
    b.onclick = async () => {
      fallbackChain.splice(Number(b.dataset.i), 1);
      await cmd('model_fallback_set', { chain: fallbackChain });
      refreshFallbacks(models);
    };
  }
  const sel = $('fb-model');
  if (sel && !sel.dataset.dirty) {
    const opts = (models ?? []).map((m) => {
      const id = typeof m === 'string' ? m : (m.id ?? '');
      const prov = typeof m === 'object' ? (m.provider ?? '') : '';
      return id ? `<option value="${escHtml(prov)}|${escHtml(id)}">${escHtml(prov ? `${prov}/` : '')}${escHtml(id)}</option>` : '';
    }).filter(Boolean);
    sel.innerHTML = opts.join('') || '<option value="">（无可用模型）</option>';
  }
}
$('fb-model')?.addEventListener('focus', () => { $('fb-model').dataset.dirty = '1'; });
$('fb-add').onclick = async () => {
  const msg = $('fb-msg');
  const v = $('fb-model').value ?? '';
  const [provider, model] = v.split('|');
  if (!provider || !model) { msg.textContent = '先选一个模型'; msg.className = 'setup-msg err'; return; }
  fallbackChain.push({ provider, model });
  const r = await cmd('model_fallback_set', { chain: fallbackChain });
  if (!r.success) { msg.textContent = `保存失败：${r.error ?? '未知'}`; msg.className = 'setup-msg err'; return; }
  fallbackChain = r.data?.chain ?? fallbackChain;
  msg.textContent = `已保存（${fallbackChain.length} 级）`;
  msg.className = 'setup-msg ok';
  delete $('fb-model').dataset.dirty;
  refreshFallbacks();
};
function updateChips() {
  const cur = modelStatus?.current;
  $('model-chip').textContent = cur ? `${cur.name ?? cur.id} ▾` : '选择模型 ▾';
  const levels = thinkLevelsForCurrent();
  const lv = modelStatus?.thinkingLevel ?? 'medium';
  $('thinking-chip').textContent = `推理 ${THINK_LABEL[levels.includes(lv) ? lv : 'off']} ▾`;
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

/* ---------- sound: opt-in notification bell (Goose terminal-bell analogue) ---------- */
const SOUND_KEY = 'pai.sound';
function soundOn() { return localStorage.getItem(SOUND_KEY) === 'on'; }
let audioCtx = null;
function beep(freq = 880, dur = 0.12) {
  if (!soundOn()) return;
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch { /* audio unavailable — silent */ }
}
if ($('set-sound')) {
  $('set-sound').value = localStorage.getItem(SOUND_KEY) ?? 'off';
  $('set-sound').onchange = () => {
    const v = $('set-sound').value;
    localStorage.setItem(SOUND_KEY, v);
    if (v === 'on') beep(); // immediate feedback that the toggle works
  };
}
if ($('set-scroll')) {
  $('set-scroll').value = scrollMode();
  $('set-scroll').onchange = () => {
    const v = $('set-scroll').value;
    localStorage.setItem(SCROLL_KEY, v);
    if (v === 'always') { nearBottom = true; scrollTail(); }
    toast(`滚动跟随：${{ near: '接近底部时跟随', always: '总是跟随', off: '从不自动滚动' }[v] ?? v}`);
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
// C12 provisioning: verify connectivity BEFORE first prompt — model_ping hits
// the provider's /models with the resolved credential; honest reachability.
$('setup-ping') && ($('setup-ping').onclick = async () => {
  const provider = $('setup-provider').value;
  const msg = $('setup-msg');
  if (!provider) return;
  msg.textContent = `正在测试 ${provider}…`; msg.className = 'setup-msg';
  const r = await cmd('model_ping', { provider });
  const d = r.data ?? {};
  if (r.success && d.ok) {
    msg.textContent = `${provider} 可达 · HTTP ${d.httpStatus} · ${d.ms}ms${d.configured === false ? '（未存密钥，仅探活）' : ''}`;
    msg.className = 'setup-msg ok';
  } else {
    msg.textContent = `连接失败：${d.error ?? r.error ?? `HTTP ${d.httpStatus ?? '?'}`}${d.configured === false ? '——先保存密钥' : ''}`;
    msg.className = 'setup-msg err';
  }
});

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
  if (rd?.success && !$('modes-json').dataset.dirty) {
    $('modes-json').value = rd.data.content ?? '';
    validateJsonInput('modes-json');
  }
}
function validateJsonInput(id) {
  const el = $(id);
  const statusEl = $(`${id}-status`);
  if (!el || !statusEl) return true;
  const val = el.value.trim();
  if (!val) {
    statusEl.textContent = '';
    statusEl.className = 'json-status';
    el.classList.remove('has-err');
    return true;
  }
  try {
    JSON.parse(val);
    statusEl.textContent = 'JSON 格式正确';
    statusEl.className = 'json-status ok';
    el.classList.remove('has-err');
    return true;
  } catch (err) {
    statusEl.textContent = `格式有误: ${err.message.slice(0, 32)}`;
    statusEl.className = 'json-status err';
    el.classList.add('has-err');
    return false;
  }
}
document.querySelectorAll('.json-format').forEach((btn) => {
  btn.onclick = () => {
    const targetId = btn.dataset.target;
    const el = $(targetId);
    if (!el) return;
    const val = el.value.trim();
    if (!val) return;
    try {
      const parsed = JSON.parse(val);
      el.value = JSON.stringify(parsed, null, 2);
      el.dataset.dirty = '1';
      validateJsonInput(targetId);
      toast('已排版 JSON');
    } catch (e) {
      toast(`排版失败：${e.message}`, true);
    }
  };
});
$('modes-save') && ($('modes-save').onclick = async () => {
  const r = await cmd('modes_save', { content: $('modes-json').value });
  const msg = $('modes-msg');
  if (r.success) {
    msg.textContent = `已保存 ${r.data.presets} 个预设`;
    msg.className = 'setup-msg ok';
    delete $('modes-json').dataset.dirty;
    validateJsonInput('modes-json');
  } else {
    msg.textContent = `保存失败：${r.error}`;
    msg.className = 'setup-msg err';
  }
  refreshModesCard(); refreshMode();
});
/* command prefix lists — .pai/commands.json (deny) + command-allow.json (ask bypass) */
async function refreshCommandsCard() {
  if (!$('commands-json')) return;
  const [d, a] = await Promise.all([cmd('commands_read'), cmd('command_allow_read')]);
  if (d?.success && !$('commands-json').dataset.dirty) {
    $('commands-json').value = d.data.content || '';
    validateJsonInput('commands-json');
  }
  if (a?.success && !$('command-allow-json').dataset.dirty) {
    $('command-allow-json').value = a.data.content || '';
    validateJsonInput('command-allow-json');
  }
}
$('commands-save') && ($('commands-save').onclick = async () => {
  const r = await cmd('commands_save', { content: $('commands-json').value });
  const msg = $('commands-msg');
  if (r.success) {
    msg.textContent = '已保存';
    msg.className = 'setup-msg ok';
    delete $('commands-json').dataset.dirty;
    validateJsonInput('commands-json');
  } else {
    msg.textContent = `保存失败：${r.error}`;
    msg.className = 'setup-msg err';
  }
});
$('command-allow-save') && ($('command-allow-save').onclick = async () => {
  const r = await cmd('command_allow_save', { content: $('command-allow-json').value });
  const msg = $('command-allow-msg');
  if (r.success) {
    msg.textContent = '已保存——命中前缀的命令不再弹批准卡';
    msg.className = 'setup-msg ok';
    delete $('command-allow-json').dataset.dirty;
    validateJsonInput('command-allow-json');
  } else {
    msg.textContent = `保存失败：${r.error}`;
    msg.className = 'setup-msg err';
  }
});
for (const id of ['modes-json', 'commands-json', 'command-allow-json']) {
  $(id)?.addEventListener('input', () => {
    $(id).dataset.dirty = '1';
    validateJsonInput(id);
  });
}
// 白名单可移植性（command_allow_export/import 接线）：导出=实例目录里落一个
// 双清单 json；导入=从实例目录里的 json 恢复两张清单。路径被后端收进实例根。
$('allow-export') && ($('allow-export').onclick = async () => {
  const msg = $('allow-xfer-msg');
  const r = await cmd('command_allow_export', {});
  if (!r.success) { msg.textContent = `导出失败：${r.error}`; msg.className = 'setup-msg err'; return; }
  msg.textContent = `已导出：${r.data?.path ?? ''}`;
  msg.className = 'setup-msg ok';
});
$('allow-import') && ($('allow-import').onclick = async () => {
  const msg = $('allow-xfer-msg');
  const name = await askText('导入清单', '实例目录里的文件名', 'command-allow-export.json');
  if (!name?.trim()) return;
  const r = await cmd('command_allow_import', { path: name.trim() });
  if (!r.success) { msg.textContent = `导入失败：${r.error}`; msg.className = 'setup-msg err'; return; }
  msg.textContent = `已导入：白名单 ${r.data?.allow ?? 0} 条 · 禁表 ${r.data?.deny ?? 0} 条`;
  msg.className = 'setup-msg ok';
  refreshCommandsCard();
});
$('set-save-key').onclick = () => saveKey('set-provider', 'set-key', 'set-model-msg');
// provider doctor — real GET {baseUrl}/models through the resolved credential
$('set-ping').onclick = async () => {
  const out = $('set-ping-result');
  out.className = 'pill';
  out.textContent = '…';
  const r = await cmd('model_ping', { provider: $('set-provider').value });
  const d = r.data ?? {};
  if (!r.success || d.ok == null) {
    out.className = 'pill err';
    out.textContent = r.error ?? d.error ?? '失败';
    return;
  }
  out.className = `pill ${d.ok ? 'ok' : 'err'}`;
  out.textContent = d.ok
    ? `通 ${d.ms}ms`
    : d.reachable ? `HTTP ${d.httpStatus}` : '不可达';
  out.title = d.error ?? `auth=${d.authSource ?? 'none'} http=${d.httpStatus ?? '—'} ${d.ms}ms`;
};
// Fetch the provider's real /models catalog and offer one-click registration —
// no more hand-typing model IDs.
$('set-fetch-models').onclick = async () => {
  const provider = $('set-provider').value;
  const box = $('set-remote-models');
  box.className = '';
  box.innerHTML = '<div class="setup-msg">正在拉取…</div>';
  const r = await cmd('provider_models_fetch', { provider });
  const d = r.data ?? {};
  if (!r.success || !d.ok) {
    box.innerHTML = `<div class="setup-msg">拉取失败：${r.error ?? d.error ?? '未知'}</div>`;
    return;
  }
  if (!d.models?.length) {
    box.innerHTML = '<div class="setup-msg">端点返回了空列表</div>';
    return;
  }
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'setup-msg';
  head.textContent = `远程目录 ${d.models.length} 个模型 —— 点击注册到本地（已存在的自动跳过）`;
  box.appendChild(head);
  for (const id of d.models) {
    const row = document.createElement('button');
    row.className = 'model-row';
    row.innerHTML = `<span class="mr-name"></span><span class="mr-meta">点击注册</span>`;
    row.querySelector('.mr-name').textContent = id;
    row.onclick = async () => {
      row.disabled = true;
      const rr = await cmd('provider_models_add', { provider, models: [id] });
      if (rr.success && rr.data?.ok !== false) {
        row.querySelector('.mr-meta').textContent = '已注册 ✓';
        await refreshModels();
      } else {
        row.disabled = false;
        row.querySelector('.mr-meta').textContent = rr.error ?? rr.data?.error ?? '失败，重试';
      }
    };
    box.appendChild(row);
  }
};
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
  const v = s.version;
  if (v && $('set-version')) {
    $('set-version').textContent = v.bootCommit ? `运行 ${v.bootCommit}${v.repoCommit && v.repoCommit !== v.bootCommit ? ` · 仓库已到 ${v.repoCommit}` : ''}` : '（无 git 信息）';
    const stale = $('version-stale');
    if (stale) stale.style.display = v.stale ? '' : 'none';
  }
  const pol = await cmd('policy_status');
  if (pol.success) renderGovCard(pol.data);
  refreshBudgetCard();
  refreshWorkspaces();
}

/* Budget control surface: operator-tier limits, hot-applied via budget_set.
 * Dirty-guarded like the JSON editors — a refresh never clobbers typing. */
async function refreshBudgetCard() {
  const b = await cmd('budget_status');
  const msg = $('budget-msg');
  if (!b.success || !b.data) { if (msg) { msg.textContent = '预算门面不可用'; msg.className = 'setup-msg err'; } return; }
  const d = b.data;
  if ($('budget-src')) $('budget-src').textContent = d.configured ? '已设限' : '未设限';
  const fill = (id, v) => { const el = $(id); if (el && !el.dataset.dirty) el.value = v ?? ''; };
  fill('budget-tokens', d.limits?.maxTokensPerSession);
  fill('budget-cost', d.limits?.maxCostPerSessionUsd);
  fill('budget-calls', d.limits?.maxCallsPerSession);
  if (msg && !msg.textContent) {
    const c = d.consumed ?? {};
    msg.textContent = `本会话已用：${c.tokens ?? 0} tok · $${(c.cost ?? 0).toFixed(4)} · ${c.calls ?? 0} 次调用`;
    msg.className = 'setup-msg';
  }
}
for (const id of ['budget-tokens', 'budget-cost', 'budget-calls']) {
  const el = $(id);
  if (el) el.addEventListener('input', () => { el.dataset.dirty = '1'; });
}
$('budget-save').onclick = async () => {
  const num = (id) => {
    const v = $(id).value.trim();
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined; // undefined = client-side invalid
  };
  const t = num('budget-tokens'), c = num('budget-cost'), k = num('budget-calls');
  const msg = $('budget-msg');
  if (t === undefined || c === undefined || k === undefined) {
    msg.textContent = '数值须为非负数字（留空清除该项）';
    msg.className = 'setup-msg err';
    return;
  }
  const r = await cmd('budget_set', { limits: { maxTokensPerSession: t, maxCostPerSessionUsd: c, maxCallsPerSession: k } });
  if (!r.success) { msg.textContent = `保存失败：${r.error ?? '未知'}`; msg.className = 'setup-msg err'; return; }
  for (const id of ['budget-tokens', 'budget-cost', 'budget-calls']) delete $(id).dataset.dirty;
  msg.textContent = t === null && c === null && k === null
    ? '已清除全部覆盖——回到 policy/env 层'
    : '已保存并即时生效（已审计）';
  msg.className = 'setup-msg ok';
  refreshGovSoon();
};
function refreshGovSoon() { setTimeout(() => { refreshBudgetCard(); }, 300); }
const RISK_LABEL = { benign: '常规', mutating: '改文件', destructive: '删改', network: '网络', privilege: '提权', exec: '执行', unknown: '未知' };
const ACTION_LABEL = { allow: '放行', deny: '拒绝', ask: '询问' };
function renderGovCard(p) {
  const rows = Object.entries(p.riskActions ?? {});
  $('gov-actions').innerHTML = rows.length
    ? rows.map(([risk, act]) => `<div class="set-row gov-row"><span class="pill">${RISK_LABEL[risk] ?? risk}</span><span class="gov-act ${act === 'deny' ? 'deny' : act === 'ask' ? 'warn' : act === 'allow' ? 'allow' : ''}">${ACTION_LABEL[act] ?? act}</span></div>`).join('')
    : '<div class="set-sub">无风险映射</div>';
  const denied = p.deniedTools ?? [];
  $('gov-denied').textContent = denied.length ? `禁用工具：${denied.join('、')}` : '无显式禁用工具';
  $('gov-sum').textContent = `${rows.length} 条规则`;
  $('gov-checksum').textContent = (p.checksum ?? '').slice(0, 16);
  // Dry-run tool hints: every tool the policy names, plus the usual suspects —
  // datalist suggests, the input still accepts any tool name.
  const dl = $('dryrun-tools');
  if (dl && !dl.dataset.filled) {
    const names = new Set(['bash', 'read', 'write', 'edit', 'ls', 'grep', 'find',
      ...Object.keys(p.toolRules ?? {})]);
    dl.innerHTML = [...names].map((t) => `<option value="${escHtml(t)}"></option>`).join('');
    dl.dataset.filled = '1';
  }
  const b = p.budget;
  $('gov-denied').textContent += (b && (b.maxTokensPerSession || b.maxCostPerSessionUsd || b.maxCallsPerSession))
    ? `；预算上限：${[b.maxTokensPerSession && `${b.maxTokensPerSession} tok`, b.maxCostPerSessionUsd && `$${b.maxCostPerSessionUsd}`, b.maxCallsPerSession && `${b.maxCallsPerSession} 次调用`].filter(Boolean).join(' · ')}`
    : '；无预算上限（所有用量仍记 append-only 账）';
}
/* Governance dry-run: rehearse a tool call against the real decide chain.
 * Verdict rendering mirrors the gov-card vocabulary (放行/拒绝/询问). */
$('dryrun-run').onclick = async () => {
  const out = $('dryrun-result');
  const tool = $('dryrun-tool').value.trim();
  if (!tool) { out.textContent = '先填工具名'; out.className = 'setup-msg err'; return; }
  const raw = $('dryrun-args').value.trim();
  let args = {};
  if (raw) {
    try { args = JSON.parse(raw); }
    catch { out.textContent = '参数不是合法 JSON'; out.className = 'setup-msg err'; return; }
  }
  out.textContent = '判定中…'; out.className = 'setup-msg';
  const r = await cmd('governance_dryrun', { tool, args });
  if (!r.success) { out.textContent = `预演失败：${r.error ?? '未知'}`; out.className = 'setup-msg err'; return; }
  const d = r.data ?? {};
  if (d.action === 'allow') {
    out.textContent = '放行 — 该调用会通过全部治理检查';
    out.className = 'setup-msg ok';
  } else if (d.action === 'ask') {
    out.textContent = `询问 — 会弹出批准卡（规则 ${d.rule ?? '?'}）${d.reason ? `：${d.reason}` : ''}`;
    out.className = 'setup-msg warn';
  } else {
    out.textContent = `拒绝 — 规则 ${d.rule ?? '?'}${d.terminate ? '（终止会话）' : ''}${d.reason ? `：${d.reason}` : ''}`;
    out.className = 'setup-msg err';
  }
};
$('set-pick-dir').onclick = async () => {
  const res = await fetch('/api/pick-dir', { method: 'POST' }).then((r) => r.json()).catch(() => ({}));
  // No native picker (dev server): fall back to a manual path prompt.
  const dir = res?.dir ?? await askText('切换工作目录', '输入完整路径', $('set-workdir').textContent);
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
    box.innerHTML = '<div class="set-sub">暂无登记工作区</div>';
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
  const dir = res?.dir ?? await askText('登记工作区', '目录完整路径');
  if (!dir) return;
  const r = await cmd('workspace_add', { path: dir });
  if (!r.success) toast(`登记失败：${r.error ?? '未知'}`, 'err');
  refreshWorkspaces();
};

/* ---------- audit / jobs ---------- */
const AUDIT_KIND_META = {
  BUDGET_DENIED: { title: '超出预算上限拦截', desc: '单次或累计模型消费超出安全阈值，已暂停调用', icon: '🛑', tag: '安全拦截', cls: 'bad' },
  RISK_MODE_SET: { title: '安全防护级别更新', desc: '系统防护策略与执行权限模式已调整', icon: '🛡️', tag: '系统策略', cls: 'info' },
  SESSION_SWITCHED: { title: '工作会话切换', desc: '上下文工作空间与会话流转', icon: '💬', tag: '会话流转', cls: 'info' },
  BODY_SELECTED: { title: 'AI 执行引擎就绪', desc: '底层 Agent 执行实体已加载并分配租约', icon: '🤖', tag: '引擎状态', cls: 'ok' },
  BODY_EXITED: { title: 'AI 执行引擎退出', desc: '执行实体进程正常关闭或交接', icon: '⏹️', tag: '引擎状态', cls: 'pending' },
  TOOL_CALL_DENIED: { title: '高危操作已拦截', desc: '根据治理策略已阻断未授权的工具调用', icon: '⛔', tag: '安全拦截', cls: 'bad' },
  TOOL_CALL_ASK: { title: '敏感操作待审批', desc: '敏感操作已暂停并等待人工审批确认', icon: '⚠️', tag: '权限审批', cls: 'warn' },
  TOOL_CALL_ALLOW: { title: '操作审批通过', desc: '用户已授权允许本次操作执行', icon: '✅', tag: '权限审批', cls: 'ok' },
  POLICY_VIOLATED: { title: '安全规则违规', desc: '检测到超出白名单或违反隔离规则的行为', icon: '⚠️', tag: '安全拦截', cls: 'bad' },
  JOB_CANCEL_REQUESTED: { title: '后台任务手动终止', desc: '操作员或系统请求停止后台任务', icon: '⏹️', tag: '任务调度', cls: 'pending' },
  JOB_QUEUED_DEPS: { title: '任务等待前序依赖', desc: '正在等待前置任务执行完成', icon: '⏳', tag: '任务调度', cls: 'pending' },
  LEASE_ACQUIRED: { title: '工作区写入锁生效', desc: '独占写入租约生效中，防止并发冲突', icon: '🔒', tag: '系统调度', cls: 'info' },
  SECRETS_REDACTED: { title: '敏感凭据自动脱敏', desc: '检测到私有密钥，已在日志与上下文中自动掩码', icon: '🛡️', tag: '凭据防护', cls: 'warn' },
  GUARDIAN_BYPASS: { title: '安全哨兵降级放行', desc: '外部审查不可达，已进入本地保障模式', icon: '⚠️', tag: '安全拦截', cls: 'warn' },
  PREDICTION_INDEX_REBUILT: { title: '本地检索索引重建', desc: '认知与预测索引已同步更新', icon: '📑', tag: '系统维护', cls: 'info' },
  PROVIDER_HEADERS: { title: '模型网络请求头', desc: '向模型服务发送的底层 HTTP 协议头', icon: '🌐', tag: '底层报文', cls: 'dim' },
  PROVIDER_REQUEST: { title: '模型网络请求体', desc: '向模型服务发送的序列化请求报文', icon: '📤', tag: '底层报文', cls: 'dim' },
  PROVIDER_RESPONSE: { title: '模型网络响应流', desc: '模型服务返回的底层数据分片', icon: '📥', tag: '底层报文', cls: 'dim' },
  TURN_ACCOUNTING: { title: '单轮 Token 计费记录', desc: '交互消耗的 Prompt / Completion Token 统计', icon: '🪙', tag: '底层报文', cls: 'dim' },
};

const AUDIT_GROUPS = {
  '安全与动态': null,
  '安全拦截': /DENIED|POLICY|GUARD|BLOCK|ASK|FAIL|ERROR|DRIFT|SECRETS|REDACT/,
  '引擎与会话': /BODY_|SESSION_|HANDOFF|MODE_|LEASE_/,
  '全部事件': /./,
  '底层报文 (Dev)': /PROVIDER_|TURN_ACCOUNTING/,
};
let auditCache = [];
let auditFilter = '安全与动态';
let auditSeen = 0;    // lines-from-end cursor: how much history we've pulled
let auditMore = false; // server says older events exist

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
    b.type = 'button';
    b.className = `af-chip${auditFilter === g ? ' on' : ''}`;
    b.textContent = g;
    b.onclick = () => { auditFilter = g; renderAuditFilters(); renderAuditList(); };
    box.appendChild(b);
  }
}
function renderAuditList() {
  const list = $('audit-list');
  list.innerHTML = '';
  const rows = auditCache.filter((e) => {
    const kind = e.kind ?? '';
    if (auditFilter === '安全与动态') {
      if (/PROVIDER_|TURN_ACCOUNTING/.test(kind)) return false;
      return true;
    }
    const re = AUDIT_GROUPS[auditFilter];
    return !re || re.test(kind);
  });
  if (!rows.length) { list.innerHTML = '<div class="sess-empty">暂无匹配的安全与治理事件</div>'; return; }
  for (const e of rows) {
    const kind = e.kind ?? '';
    const meta = AUDIT_KIND_META[kind] || {
      title: kind.replace(/_/g, ' '),
      desc: '系统运行事件',
      icon: '●',
      tag: '系统事件',
      cls: auditKindClass(kind)
    };
    const div = document.createElement('div');
    div.className = 'audit-row';
    div.setAttribute('tabindex', '0');
    div.setAttribute('role', 'button');
    div.setAttribute('aria-expanded', 'false');
    const timeStr = (e.ts ?? e.time ?? '').slice(5, 19).replace('T', ' ');
    const tagHtml = `<span class="a-tag ${meta.cls}">${meta.tag}</span>`;
    const runInfo = e.toolName ? `工具: ${e.toolName}` : '';

    div.innerHTML = `
      <div class="a-main">
        <span class="a-icon">${meta.icon}</span>
        <div class="a-info">
          <div class="a-title-row">
            <span class="a-kind ${meta.cls}">${meta.title}</span>
            ${tagHtml}
          </div>
          <span class="a-sub">${meta.desc}</span>
        </div>
      </div>
      <div class="a-meta">
        <span class="a-run">${escapeHtml(runInfo)}</span>
        <span class="a-ts">${timeStr}</span>
        <svg class="a-caret" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>
      </div>
      <div class="a-detail hidden"></div>`;

    const detail = div.querySelector('.a-detail');
    const payload = { ...(e.data ?? {}) };
    delete payload.parent_run_id;
    const hasData = Object.keys(payload).length > 0;
    const jsonStr = hasData ? JSON.stringify(payload, null, 2) : '';

    if (hasData) {
      detail.innerHTML = `
        <div class="a-detail-bar">
          <span class="a-detail-title">事件载荷数据</span>
          <button type="button" class="btn ghost sm a-copy-btn" title="复制完整事件 JSON">复制 JSON</button>
        </div>
        <pre class="a-detail-pre"><code>${escapeHtml(jsonStr)}</code></pre>`;
      const copyBtn = detail.querySelector('.a-copy-btn');
      if (copyBtn) {
        copyBtn.onclick = async (evt) => {
          evt.stopPropagation();
          try {
            await navigator.clipboard.writeText(jsonStr);
            copyBtn.textContent = '已复制';
            copyBtn.classList.add('copied');
            setTimeout(() => {
              copyBtn.textContent = '复制 JSON';
              copyBtn.classList.remove('copied');
            }, 1500);
          } catch {
            toast('复制失败', true);
          }
        };
      }
    } else {
      detail.innerHTML = '<div class="dim" style="padding:4px 0">（无附加载荷数据）</div>';
    }

    detail.onclick = (evt) => evt.stopPropagation();

    const toggleRow = () => {
      const isOpening = detail.classList.contains('hidden');
      detail.classList.toggle('hidden');
      div.classList.toggle('open', isOpening);
      div.setAttribute('aria-expanded', isOpening ? 'true' : 'false');
    };
    div.onclick = toggleRow;
    div.onkeydown = (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        toggleRow();
      }
    };
    list.appendChild(div);
  }
  // Full-history paging: the audit log is the governance record — an
  // 80-event window is not oversight. "load earlier" walks the cursor back.
  if (auditMore) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn ghost sm';
    more.style.margin = '8px auto';
    more.style.display = 'block';
    more.textContent = '加载更早的事件…';
    more.onclick = () => refreshAudit(true);
    list.appendChild(more);
  }
}
async function refreshAudit(older = false) {
  if (!older) { auditCache = []; auditSeen = 0; auditMore = false; }
  const r = await cmd('audit_tail', { n: 200, before: auditSeen });
  const d = r.data ?? {};
  const events = Array.isArray(d) ? d : (d.events ?? []);
  auditMore = Array.isArray(d) ? false : Boolean(d.hasMore);
  // oldest-first from server; cache keeps newest-first for display
  auditCache = [...auditCache, ...events.slice().reverse()];
  auditSeen += events.length;
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

$('jobs-clear-history') && ($('jobs-clear-history').onclick = async () => {
  const r = await cmd('job_list', { n: 100 });
  const terminal = (r.data ?? []).filter((j) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(j.job_state));
  if (!terminal.length) { toast('暂无已结束的历史任务'); return; }
  let deleted = 0;
  for (const j of terminal) {
    const res = await cmd('job_delete', { job_id: j.job_id });
    if (res.success) deleted++;
  }
  toast(`已清理 ${deleted} 条已完成/失败的任务记录`);
  refreshJobs();
});

$('jobs-stop-all') && ($('jobs-stop-all').onclick = async () => {
  if (!confirm('全部停止：中止当前运行，并取消所有未完成的持久任务？')) return;
  const r = await cmd('stop_all');
  if (r.success) {
    toast(`已停止——前台${r.data?.aborted ? '已中止' : '无运行'} · 取消 ${r.data?.cancelled?.length ?? 0} 个任务`);
    refreshJobs();
  } else toast(`停止失败：${r.error ?? '未知'}`, 'err');
});

async function refreshJobs() {
  paintGoalLine();
  const r = await cmd('job_list', { n: 50 });
  const tbody = $('jobs').querySelector('tbody');
  tbody.innerHTML = '';
  const jobs = r.data ?? [];
  if ($('badge-jobs')) $('badge-jobs').textContent = jobs.length;
  if (!jobs.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-3);padding:32px 20px;font-family:var(--font)">当前无正在运行的后台任务</td></tr>';
    return;
  }
  for (const j of jobs) {
    const tr = document.createElement('tr');
    let queued = false;
    try { queued = !j.current_attempt_id && JSON.parse(j.depends_on ?? '[]').length > 0; } catch { /* bad JSON → not queued */ }

    // Human-readable command title with clean prompt styling
    const typeMap = {
      shell_command: '终端命令执行',
      shell: '终端命令执行',
      file_edit: '文件代码修改',
      file_write: '文件写入',
      file_read: '文件读取',
      test_run: '测试运行'
    };
    const isShell = j.job_type === 'shell_command' || j.job_type === 'shell';
    let rawCmd = j.command || j.label || '';
    if (!rawCmd && isShell) {
      // Asynchronously fetch status to populate exact command if missing in summary
      cmd('job_status', { job_id: j.job_id }).then((st) => {
        const realCmd = st.data?.detail?.command;
        if (realCmd) {
          const titleEl = tr.querySelector('.job-cmd-title');
          if (titleEl) {
            const formatted = realCmd.length > 80 ? `${realCmd.slice(0, 80)}…` : realCmd;
            titleEl.innerHTML = `<span class="job-cmd-prompt">$</span> <span class="job-cmd-text">${escapeHtml(formatted)}</span>`;
            tr.title = `点击查看终端输出及详情\n指令: ${realCmd}\n(ID: ${j.job_id})`;
          }
        }
      });
      rawCmd = `后台指令 (${j.job_id.slice(0, 10)})`;
    }
    if (!rawCmd) rawCmd = typeMap[j.job_type] || j.job_type || '后台任务';
    const displayCmd = rawCmd.length > 80 ? `${rawCmd.slice(0, 80)}…` : rawCmd;

    // Human-readable status pill
    const state = queued ? 'queued' : (j.job_state || '').toLowerCase();
    const stateMap = {
      completed: { text: '已完成', icon: '✅', cls: 'done' },
      failed: { text: '执行失败', icon: '❌', cls: 'err' },
      running: { text: '运行中', icon: '⏳', cls: 'doing' },
      pending: { text: '排队中', icon: '⏸', cls: 'pending' },
      queued: { text: '等待依赖', icon: '⏳', cls: 'pending' },
      cancelled: { text: '已取消', icon: '⏹', cls: 'pending' }
    };
    const s = stateMap[state] || { text: j.job_state || '未知', icon: '●', cls: 'pending' };
    const statusHtml = `<span class="job-pill ${s.cls}">${s.icon} ${s.text}</span>`;
    const timeStr = (j.updated_at ?? '').slice(0, 19).replace('T', ' ');

    tr.innerHTML = `<td><span class="job-cmd-title"></span></td><td>${statusHtml}</td><td class="job-time">${timeStr}</td>`;
    const titleEl = tr.querySelector('.job-cmd-title');
    if (j.command || rawCmd.startsWith('ping') || rawCmd.startsWith('timeout') || rawCmd.startsWith('npm') || rawCmd.startsWith('pytest') || rawCmd.includes(' ')) {
      titleEl.innerHTML = `<span class="job-cmd-prompt">$</span> <span class="job-cmd-text">${escapeHtml(displayCmd)}</span>`;
    } else {
      titleEl.textContent = displayCmd;
    }
    tr.classList.add('clickable');
    tr.title = `点击查看终端输出及详情 (ID: ${j.job_id})`;
    tr.onclick = () => openJobDetail(j.job_id);
    tbody.appendChild(tr);
  }
  refreshSchedules();
  refreshGoals();
  refreshTasks();
  refreshMonitors();
  paintStatusline(); // workspace-write lease rides job lifecycle
}

/* ---------- coordinator goals (operator mirror of goal_coordinator) ---------- */
async function refreshGoals() {
  const tbody = $('goals')?.querySelector('tbody');
  if (!tbody) return;
  const r = await cmd('goal_list');
  const rows = r.success ? (r.data ?? []) : [];
  if ($('badge-goals')) $('badge-goals').textContent = rows.length;
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-3);padding:32px 20px;font-family:var(--font)">当前无追踪的长期目标</td></tr>';
    return;
  }
  for (const g of rows) {
    const tr = document.createElement('tr');
    const cells = [
      g.goal_id, g.state,
      g.schedule_id ?? '—',
      String(g.task_ids?.length ?? 0),
      g.last_tick_at ? new Date(g.last_tick_at).toLocaleString() : '从未',
      (g.statement ?? '').slice(0, 60),
    ];
    tr.innerHTML = cells.map(() => '<td></td>').join('') + '<td><button class="ghost-btn warn"></button></td>';
    tr.querySelectorAll('td').forEach((td, i) => { if (i < cells.length) td.textContent = cells[i]; });
    const btn = tr.querySelector('button');
    if (g.state === 'done') { btn.textContent = '已完成'; btn.disabled = true; }
    else {
      btn.textContent = g.state === 'paused' ? '恢复' : '暂停';
      btn.onclick = async () => {
        await cmd('goal_set', { id: g.goal_id, state: g.state === 'paused' ? 'open' : 'paused' });
        refreshGoals();
      };
    }
    tbody.appendChild(tr);
  }
}

/* ---------- durable schedules (operator mirror of schedule_task) ---------- */
async function refreshSchedules() {
  const tbody = $('schedules')?.querySelector('tbody');
  if (!tbody) return;
  const r = await cmd('schedule_list');
  const rows = r.success ? (r.data ?? []) : [];
  if ($('badge-schedules')) $('badge-schedules').textContent = rows.length;
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:32px 20px;font-family:var(--font)">当前无排程的定时调度</td></tr>';
    return;
  }
  for (const s of rows) {
    const tr = document.createElement('tr');
    const kind = `${s.kind}${s.every_seconds ? ` ${s.every_seconds}s` : ''}${s.enabled === false ? '（停用）' : ''}`;
    const cells = [
      s.id, kind,
      s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—',
      s.lastFiredAt ? new Date(s.lastFiredAt).toLocaleString() : '从未',
      (s.label ?? s.command ?? '').slice(0, 60),
    ];
    tr.innerHTML = cells.map(() => '<td></td>').join('')
      + '<td><button class="ghost-btn"></button> <button class="ghost-btn warn">取消</button></td>';
    tr.querySelectorAll('td').forEach((td, i) => { if (i < cells.length) td.textContent = cells[i]; });
    const [toggleBtn, cancelBtn] = tr.querySelectorAll('button');
    toggleBtn.textContent = s.enabled === false ? '恢复' : '暂停';
    toggleBtn.onclick = async () => {
      await cmd('schedule_set', { id: s.id, enabled: s.enabled === false });
      refreshSchedules();
    };
    cancelBtn.onclick = async () => { await cmd('schedule_cancel', { id: s.id }); refreshSchedules(); };
    tbody.appendChild(tr);
  }
}

/* ---------- monitors (event-driven watch → prompt sink) ---------- */
async function refreshMonitors() {
  const tbody = $('monitors')?.querySelector('tbody');
  if (!tbody) return;
  const r = await cmd('monitor_list');
  const rows = r.success ? (r.data ?? []) : [];
  if ($('badge-monitors')) $('badge-monitors').textContent = rows.length;
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:32px 20px;font-family:var(--font)">暂无值守监视——盯住一个路径，变化时自动执行指令</td></tr>';
    return;
  }
  for (const m of rows) {
    const tr = document.createElement('tr');
    const cells = [
      m.id, m.path, (m.prompt ?? '').slice(0, 60),
      String(m.fires ?? 0),
      m.lastFired ? new Date(m.lastFired).toLocaleString() : '从未',
    ];
    tr.innerHTML = cells.map(() => '<td></td>').join('') + '<td><button class="ghost-btn warn">移除</button></td>';
    tr.querySelectorAll('td').forEach((td, i) => { if (i < cells.length) td.textContent = cells[i]; });
    tr.querySelector('button').onclick = async () => {
      await cmd('monitor_remove', { id: m.id });
      refreshMonitors();
    };
    tbody.appendChild(tr);
  }
}
$('mon-add').onclick = async () => {
  const msg = $('mon-msg');
  const path = $('mon-path').value.trim();
  const prompt = $('mon-prompt').value.trim();
  if (!path || !prompt) { msg.textContent = '路径和指令都要填'; msg.className = 'setup-msg err'; return; }
  const r = await cmd('monitor_add', { path, prompt });
  if (!r.success) { msg.textContent = `添加失败：${r.error ?? '未知'}`; msg.className = 'setup-msg err'; return; }
  msg.textContent = `已添加 ${r.data?.id ?? ''}`;
  msg.className = 'setup-msg ok';
  $('mon-path').value = ''; $('mon-prompt').value = '';
  refreshMonitors();
};

/* ---------- AgentTask mailbox center (F-family) ---------- */
let activeTask = null;

async function refreshTasks() {
  const tbody = $('tasks').querySelector('tbody');
  tbody.innerHTML = '';
  const r = await cmd('task_list');
  const tasks = r.success ? (r.data ?? []) : [];
  if ($('badge-tasks')) $('badge-tasks').textContent = tasks.length;
  if (!tasks.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:32px 20px;font-family:var(--font)">当前无子任务协作信箱</td></tr>';
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
    const cells = [t.task_id?.slice(0, 16) ?? '', t.label ?? '', t.stale ? `${t.state ?? ''} · 失联` : (t.state ?? ''), (t.job_id ?? '').slice(0, 12), `收${t.inbox_count ?? 0}/发${t.outbox_count ?? 0}`];
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
  startTaskPoll();
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
  // a closed task's mailbox is immutable — stop polling, keep the stream readable
  if (st === 'closed') stopTaskPoll();
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
// M77: the detail view's 1.5s refresh is a real lifecycle — starts when a
// task is opened, stops when the task closes or the operator leaves the view.
function startTaskPoll() {
  stopTaskPoll();
  taskTimer = setInterval(() => { if (activeTask) paintTask(); }, 1500);
}
function stopTaskPoll() {
  clearInterval(taskTimer);
  taskTimer = null;
}

/* ---------- changes & artifacts (fileops receipt stream) ---------- */
const OP_LABEL = { write: '写入', create: '新建', delete: '删除', backup: '备份' };

// Artifacts panel — everything exported under <instance>/exports browsable.
async function refreshArtifacts() {
  const tbody = $('artifacts')?.querySelector('tbody');
  if (!tbody) return;
  const r = await fetch('/api/artifacts').then((x) => x.json()).catch(() => ({}));
  const rows = r.artifacts ?? [];
  if ($('badge-artifacts')) $('badge-artifacts').textContent = rows.length;
  tbody.innerHTML = '';
  if (!rows.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="3" class="empty-cell">
          <svg class="empty-cell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
          <div class="empty-cell-title">暂无导出产物</div>
        </td>
      </tr>`;
    return;
  }
  for (const a of rows) {
    const tr = document.createElement('tr');
    const name = a.path.split(/[\\/]/).slice(-2).join('/');
    tr.innerHTML = `<td><a href="/api/artifact?path=${encodeURIComponent(a.path)}" target="_blank" rel="noopener"></a></td><td></td><td></td>`;
    const [c1, c2, c3] = tr.querySelectorAll('td');
    c1.querySelector('a').textContent = name;
    c1.querySelector('a').title = a.path;
    c2.textContent = a.bytes > 1024 * 1024 ? `${(a.bytes / 1048576).toFixed(1)}MB` : `${Math.round(a.bytes / 1024)}KB`;
    c3.textContent = a.mtime ? new Date(a.mtime).toLocaleString() : '';
    tbody.appendChild(tr);
  }
}

async function refreshChanges() {
  const r = await cmd('fileops_list', { n: 200 });
  const tbody = $('changes').querySelector('tbody');
  tbody.innerHTML = '';
  const ops = r.data ?? [];
  if ($('badge-changes')) $('badge-changes').textContent = ops.length;
  if (!r.success) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-cell"><div class="empty-cell-title">此身体不支持变更回执</div></td></tr>';
    return;
  }
  if (!ops.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-cell">
          <svg class="empty-cell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="M9 15l3 3 3-3"/></svg>
          <div class="empty-cell-title">暂无文件改动回执</div>
        </td>
      </tr>`;
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
      if (rd.success && rd.data?.diffs?.length) {
        const rows = rd.data.diffs[0].diff.split('\n').map((l) => {
          const cls = l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : /^@@|^\s*$/.test(l) ? 'd-hunk' : '';
          return `<span class="${cls}">${escHtml(l)}</span>`;
        }).join('\n');
        td.innerHTML = `<pre class="change-diff"><code>${rows}</code></pre>`;
      } else {
        const body = rd.data?.skipped?.[0]?.reason ?? rd.error ?? '无差异（产物已不在）';
        td.innerHTML = '<pre class="change-diff"></pre>';
        td.querySelector('pre').textContent = body;
      }
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
    // M105: tool-call-scoped undo — revert every receipt attributed to the
    // same tool call, plus a checkpoint boundary that rewinds the workspace
    // to just before this receipt.
    if (op.toolCallId) {
      const cbtn = document.createElement('button');
      cbtn.className = 'btn ghost sm';
      cbtn.textContent = '撤调用';
      cbtn.title = `撤销调用 ${op.toolCallId} 的全部文件变更`;
      cbtn.onclick = async () => {
        cbtn.disabled = true;
        const rr = await cmd('fileops_undo_call', { toolCallId: op.toolCallId });
        if (rr.success) { toast(`已撤销调用：恢复 ${rr.data?.restored?.length ?? 0} 项${rr.data?.skipped?.length ? `，跳过 ${rr.data.skipped.length}` : ''}`); refreshChanges(); }
        else { toast(`撤销失败：${rr.error ?? '未知'}`, 'err'); cbtn.disabled = false; }
      };
      actCell.appendChild(cbtn);
    }
    const wbtn = document.createElement('button');
    wbtn.className = 'btn ghost sm';
    wbtn.textContent = '回退到此';
    wbtn.title = '撤销此回执及之后全部文件变更（回到该变更之前的工作区状态）';
    wbtn.onclick = async () => {
      if (!confirm(`回退到此回执？将撤销该变更及其后全部 ${'(含)'} 已记录文件变更，且恢复本身可被再次恢复。`)) return;
      wbtn.disabled = true;
      const rr = await cmd('fileops_rewind', { receiptId: op.receiptId });
      if (rr.success) { toast(`已回退：恢复 ${rr.data?.restored?.length ?? 0} 项${rr.data?.skipped?.length ? `，跳过 ${rr.data.skipped.length}` : ''}`); refreshChanges(); }
      else { toast(`回退失败：${rr.error ?? '未知'}`, 'err'); wbtn.disabled = false; }
    };
    actCell.appendChild(wbtn);
    tbody.appendChild(tr);
  }
}

async function openJobDetail(jobId) {
  const panel = $('job-detail');
  const r = await cmd('job_status', { job_id: jobId });
  if (!r.success) { toast(`读取任务失败：${r.error ?? '未知'}`, 'err'); return; }
  const { job, detail } = r.data ?? {};
  panel.classList.remove('hidden');

  const isFailed = job?.job_state === 'FAILED';
  const isCompleted = job?.job_state === 'COMPLETED';
  const isRunning = detail?.running || job?.job_state === 'RUNNING';
  const statusLabel = isCompleted ? '✅ 执行完成' : isFailed ? `❌ 运行失败（退出码: ${detail?.exit_code ?? 1}）` : isRunning ? '⏳ 正在运行中…' : (job?.job_state ?? '未知状态');
  const statusCls = isCompleted ? 'done' : isFailed ? 'err' : isRunning ? 'doing' : 'pending';

  panel.innerHTML = `
    <div class="jd-head">
      <div class="jd-title-box">
        <span class="jd-title">任务详情</span>
        <span class="jd-id-dim" title="内部任务ID: ${job?.job_id ?? jobId}">ID: ${(job?.job_id ?? jobId).slice(0, 12)}</span>
      </div>
      <div class="jd-actions">
        <button class="ghost-btn jd-restart hidden" type="button">重新运行</button>
        <button class="ghost-btn warn jd-delete hidden" type="button">删除记录</button>
        <button class="ghost-btn jd-cancel hidden" type="button">停止任务</button>
        <button class="icon-btn jd-close" type="button" title="关闭">✕</button>
      </div>
    </div>
    <div class="jd-card">
      <div class="jd-row">
        <div class="jd-row-head">
          <span class="jd-k">执行指令</span>
          <button type="button" class="btn ghost sm jd-copy-btn jd-copy-cmd" title="复制执行指令">复制</button>
        </div>
        <pre class="jd-cmd"></pre>
      </div>
      <div class="jd-row">
        <span class="jd-k">执行状态</span>
        <div class="jd-status-badge"><span class="job-pill ${statusCls}">${statusLabel}</span></div>
      </div>
      <div class="jd-row jd-deps-row hidden">
        <span class="jd-k">等待前序依赖</span>
        <span class="jd-deps"></span>
      </div>
      <div class="jd-row">
        <div class="jd-row-head">
          <span class="jd-k">终端输出日志</span>
          <button type="button" class="btn ghost sm jd-copy-btn jd-copy-out" title="复制终端日志">复制</button>
        </div>
        <pre class="jd-out"></pre>
      </div>
    </div>`;

  const typeMap = { shell_command: '终端命令执行', file_edit: '文件代码修改', file_write: '文件写入', file_read: '文件读取', test_run: '测试运行' };
  panel.querySelector('.jd-cmd').textContent = detail?.command || typeMap[job?.job_type] || job?.job_type || '—';
  // Dependency chains: show what the job waits/waited on
  const depRow = panel.querySelector('.jd-deps-row');
  const deps = detail?.depends_on;
  if (deps?.deps?.length) {
    depRow.classList.remove('hidden');
    const tag = (id) => deps.failed.includes(id) ? `${id}✗` : deps.pending.includes(id) ? `${id}…` : `${id}✓`;
    panel.querySelector('.jd-deps').textContent =
      deps.deps.map(tag).join('  ') +
      (detail.queued ? '（排队中——全部完成后自动启动；任一失败则取消）' : '');
  } else {
    depRow.classList.add('hidden');
  }
  panel.querySelector('.jd-out').textContent = detail?.output_tail || '（暂无输出）';

  const cmdCopy = panel.querySelector('.jd-copy-cmd');
  if (cmdCopy) {
    cmdCopy.onclick = async () => {
      const text = panel.querySelector('.jd-cmd')?.textContent ?? '';
      if (!text || text === '—') return;
      try {
        await navigator.clipboard.writeText(text);
        cmdCopy.textContent = '已复制';
        setTimeout(() => { cmdCopy.textContent = '复制'; }, 1500);
      } catch {
        toast('复制失败', true);
      }
    };
  }
  const outCopy = panel.querySelector('.jd-copy-out');
  if (outCopy) {
    outCopy.onclick = async () => {
      const text = panel.querySelector('.jd-out')?.textContent ?? '';
      if (!text || text === '（暂无输出）') return;
      try {
        await navigator.clipboard.writeText(text);
        outCopy.textContent = '已复制';
        setTimeout(() => { outCopy.textContent = '复制'; }, 1500);
      } catch {
        toast('复制失败', true);
      }
    };
  }
  const cancelBtn = panel.querySelector('.jd-cancel');
  const terminal = job?.job_state && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.job_state);
  const cancellable = detail?.running || (job?.job_state && !terminal);
  // M90/M92: terminal jobs expose restart (new job, same command) + delete
  const restartBtn = panel.querySelector('.jd-restart');
  const deleteBtn = panel.querySelector('.jd-delete');
  if (terminal) {
    restartBtn.classList.remove('hidden');
    deleteBtn.classList.remove('hidden');
    restartBtn.disabled = !detail?.command;
    restartBtn.title = detail?.command ? '以同一命令重跑为新任务' : '无命令记录，无法重启';
    restartBtn.onclick = async () => {
      if (!confirm(`以同一命令重启新任务？（原任务 ${jobId} 保持不变）`)) return;
      const rr = await cmd('job_restart', { job_id: jobId });
      if (rr.success) { toast(`已重启为 ${rr.data?.job_id ?? '新任务'}`, 'ok'); refreshJobs(); }
      else toast(`重启被拒：${rr.error ?? '未知'}`, 'err');
    };
    deleteBtn.onclick = async () => {
      if (!confirm(`确定删除任务 ${jobId} 的记录与产物？此操作不可恢复`)) return;
      const dr = await cmd('job_delete', { job_id: jobId });
      if (dr.success) { toast('任务已删除', 'ok'); panel.classList.add('hidden'); refreshJobs(); }
      else toast(`删除被拒：${dr.error ?? '未知'}`, 'err');
    };
  }
  if (cancellable) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.onclick = async () => {
      if (!confirm(`确定停止任务 ${jobId}？`)) return;
      const cr = await cmd('job_cancel', { job_id: jobId });
      if (cr.success) { toast(cr.data?.killed ? '任务已停止' : '任务已标记取消', 'ok'); openJobDetail(jobId); refreshJobs(); }
      else toast(`停止失败：${cr.error ?? '未知'}`, 'err');
    };
  }
  panel.querySelector('.jd-close').onclick = () => panel.classList.add('hidden');
  panel.scrollIntoView({ block: 'nearest' });
}

/* ---------- bodies ---------- */
const BODY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/><circle cx="9.5" cy="13" r="1.2" fill="currentColor"/><circle cx="14.5" cy="13" r="1.2" fill="currentColor"/></svg>';
let bodiesCache = [];

const BODY_DESC = {
  pi: '本地轻量引擎 · 零配置极速响应，支持单智能体长程作业',
  dsh: '分布式协作引擎 · 面向多智能体与节点拓扑互联',
};

async function refreshBodies() {
  const r = await cmd('body_list');
  const grid = $('body-grid');
  grid.innerHTML = '';
  bodiesCache = r.data ?? [];

  const cur = bodiesCache.find((b) => b.current);
  $('body-chip').textContent = cur ? `${cur.label} ▾` : '选择引擎 ▾';

  for (const b of bodiesCache) {
    const card = document.createElement('div');
    card.className = `body-card${b.current ? ' current' : ''}`;
    const elig = b.eligibility ?? {};
    const notes = [
      ...(elig.failClosed ?? []).map((f) => `<div class="fc">✗ ${f.reason || f.invariant}</div>`),
      ...(elig.degraded ?? []).map((d) => `<div class="dg">△ ${d}</div>`),
    ];
    const pills = [
      b.current ? '<span class="pill on">使用中</span>' : '',
      b.installed ? '<span class="pill ok">就绪</span>' : '<span class="pill err">未安装</span>',
      b.has_channel ? '' : '<span class="pill warn">无会话通道</span>',
    ].join('');
    const desc = BODY_DESC[b.body_id] ?? (b.installed ? '已就绪' : '未检测到环境');
    const showHint = !b.installed && b.install_hint && !notes.some((n) => n.includes(b.install_hint));
    card.innerHTML = `
      <div class="bc-head">
        <div class="bc-icon">${BODY_ICON}</div>
        <div>
          <div class="bc-title">${b.label} ${pills}</div>
          <div class="bc-sub">${desc}</div>
        </div>
      </div>
      ${notes.length ? `<div class="bc-notes">${notes.join('')}</div>` : ''}
      <div class="bc-foot">
        ${showHint ? `<span class="bc-hint">${b.install_hint}</span>` : ''}
        ${b.current ? '<span class="bc-cur-badge">当前使用中</span>' : (b.installed ? `<button type="button" class="use-btn" data-body="${b.body_id}">切换为此引擎</button>` : '')}
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
  if (currentView === 'chat') $('view-title').textContent = name || '新对话';
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
  // D7 lease badge: canonical writer owner + workspace-write mutex holder.
  // The writer lease is held by the live body for the session's lifetime —
  // surfacing it makes "who can write canonical state" visible, not implicit.
  const leases = await cmd('lease_status');
  if (leases.success && leases.data) {
    const w = leases.data.writer?.owner;
    const ws = leases.data.workspaceWrite?.holder;
    if (w) parts.push(`✍ ${String(w).slice(0, 12)}`);
    if (ws) parts.push(`🔒${String(ws).slice(0, 14)}`);
  }
  el.textContent = parts.join('  ·  ');
}
function refreshAll() { refreshBodies(); refreshJobs(); refreshAudit(); refreshSessions(); refreshSettings(); refreshMode(); refreshMacros(); refreshTodos(); refreshState().then(checkProjectTrust); }
function setStatus(t, kind) {
  $('status').textContent = t;
  $('status-dot').className = `dot${kind === 'err' ? ' err' : t === '就绪' ? ' on' : ''}`;
}

/* ---------- views ---------- */
const TITLES = { jobs: '后台任务', changes: '文件变更与产物', audit: '安全审计日志', bodies: 'AI 引擎', settings: '设置' };
let currentView = 'chat';
function switchView(v) {
  currentView = v;
  for (const item of document.querySelectorAll('.nav-item')) item.classList.toggle('active', item.dataset.view === v);
  for (const sec of document.querySelectorAll('.view')) sec.classList.toggle('hidden', sec.id !== `view-${v}`);
  if (v === 'chat') {
    const curS = sessionsCache.find((s) => s.path === currentSessionFile);
    const rawN = curS?.name || curS?.firstMessage;
    $('view-title').textContent = (!rawN || rawN.trim() === '(no messages)') ? '新对话' : rawN;
  }
  else $('view-title').textContent = TITLES[v] ?? '';
  if (v === 'jobs') { refreshJobs(); if (activeTask) startTaskPoll(); }
  else stopTaskPoll();
  if (v === 'changes') { refreshChanges(); refreshArtifacts(); }
  if (v === 'audit') refreshAudit();
  if (v === 'bodies') refreshBodies();
  if (v === 'about') refreshAbout();
  if (v === 'settings') { refreshSettings(); refreshModels(); refreshMemory(); refreshModesCard(); refreshCommandsCard(); }
}
for (const item of document.querySelectorAll('.nav-item')) item.onclick = () => switchView(item.dataset.view);
for (const tab of document.querySelectorAll('.jtab')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.jtab')) t.classList.remove('active');
    tab.classList.add('active');
    const target = tab.dataset.jtab;
    for (const p of document.querySelectorAll('.jobs-panel')) p.classList.add('hidden');
    $(`panel-${target}`)?.classList.remove('hidden');
  };
}
for (const tab of document.querySelectorAll('.ctab')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('.ctab')) t.classList.remove('active');
    tab.classList.add('active');
    const target = tab.dataset.ctab;
    for (const p of document.querySelectorAll('.changes-panel')) p.classList.add('hidden');
    $(`panel-${target}`)?.classList.remove('hidden');
  };
}

/* about view — every claim on this page is backed by a live facade read,
   so the evidence grid can never drift ahead of the runtime */
async function refreshAbout() {
  const box = $('about-evidence');
  if (!box) return;
  box.innerHTML = '<div class="set-sub">读取中…</div>';
  const [pol, bodies, jobs, skills, scheds, trust, mem] = await Promise.all([
    cmd('policy_status'), cmd('body_list'), cmd('job_list', { n: 200 }),
    cmd('skills_list'), cmd('schedule_list'), cmd('project_trust_status'), cmd('memory_stats'),
  ]);
  const jl = jobs.data ?? [];
  const running = jl.filter((x) => x.job_state === 'RUNNING').length;
  const chips = [
    ['治理姿态', pol.success
      ? `policy ${String(pol.data?.checksum ?? '').slice(0, 10) || '—'} · ${(pol.data?.deniedTools ?? []).length} 个工具硬拒`
      : 'facade 不可用'],
    ['身体', bodies.success ? `${(bodies.data ?? []).length} 个已登记` : 'facade 不可用'],
    ['持久任务', jobs.success ? `${jl.length} 个 · ${running} 运行中` : 'facade 不可用'],
    ['技能', skills.success ? `${(skills.data?.skills ?? []).length} 个已加载` : '未配置 microagent'],
    ['定时任务', scheds.success ? `${(scheds.data ?? []).length} 个` : 'facade 不可用'],
    ['项目信任', trust.success
      ? (trust.data?.trusted ? '已授予——仓库注入内容激活' : '未授予——仓库注入内容休眠中')
      : 'facade 不可用'],
    ['记忆', mem.success ? `${mem.data?.pinned ?? 0} 条 pinned / ${mem.data?.total ?? 0} 总` : 'facade 不可用'],
  ];
  box.innerHTML = chips.map(([k, v]) =>
    `<div class="ev-chip"><div class="ev-k">${escHtml(k)}</div><div class="ev-v">${escHtml(v)}</div></div>`).join('');
}
$('body-chip').onclick = () => switchView('bodies');
$('empty-about') && ($('empty-about').onclick = () => switchView('about'));

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
  { cmd: '/new', label: '新建对话', hint: '开启一个新的干净对话', run: () => $('new-task').click() },
  { cmd: '/abort', label: '中止运行', hint: '停止当前任务', run: async () => { await cmd('abort'); } },
  { cmd: '/model', label: '选择模型', hint: '弹出模型菜单', run: () => $('model-chip').click() },
  {
    cmd: '/discover', label: '发现本地模型', hint: '探测 Ollama/LM Studio/llama.cpp 本地节点',
    run: async () => {
      const r = await cmd('model_discover');
      if (!r.success) { addSys(`探测失败：${r.error ?? '未知'}`, true); return; }
      const nodes = r.data?.nodes ?? [];
      if (!nodes.length) { addSys('未发现本地推理节点（Ollama :11434 / LM Studio :1234 / llama.cpp :8080）'); return; }
      addSys(`发现 ${nodes.length} 个本地节点：\n` + nodes.map((n) =>
        `· ${n.kind} ${n.url} — ${n.models.length ? n.models.slice(0, 8).join('、') + (n.models.length > 8 ? ` …共${n.models.length}个` : '') : '无模型'}`).join('\n')
        + '\n接入方式：模型面板添加 provider，api=openai-completions，baseUrl 填 <节点>/v1');
    },
  },
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
    cmd: '/export', label: '导出会话', hint: '导出为 HTML（/export jsonl|debug|md|quarto 导轨迹/调试包/markdown/quarto）',
    run: async (arg) => {
      const a = String(arg ?? '').trim().toLowerCase();
      const format = ['jsonl', 'debug', 'markdown', 'md', 'quarto'].includes(a) ? a : 'html';
      const r = await cmd('session_export', { format });
      if (r.success && r.data?.file) toast(`已导出：${r.data.file}`);
      else addSys(`导出失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    cmd: '/pin', label: '钉文件进上下文', hint: '/pin <路径> 每轮注入该文件最新内容；/pin 列出现有钉',
    run: async (arg) => {
      const p = String(arg ?? '').trim();
      if (!p) {
        const r = await cmd('pins_list');
        const paths = r.data?.paths ?? [];
        addSys(paths.length ? `已钉文件：\n${paths.map((x) => `  · ${x}`).join('\n')}` : '没有钉住的文件——/pin <路径> 钉一个');
        return;
      }
      const r = await cmd('pins_add', { path: p });
      if (r.success) toast(`已钉：${p}（每轮注入最新内容）`);
      else addSys(`钉失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    cmd: '/unpin', label: '取消钉文件', hint: '从上下文钉列表移除',
    run: async () => {
      const r = await cmd('pins_list');
      const paths = r.data?.paths ?? [];
      if (!paths.length) { addSys('没有钉住的文件', true); return; }
      openMenu(paths.map((x) => ({ label: x, value: x })), async (it) => {
        const r2 = await cmd('pins_remove', { path: it.value });
        if (r2.success) toast(`已移除：${it.value}`);
        else addSys(`移除失败：${r2.error ?? '未知'}`, true);
      });
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
      const a = s.asks ?? {};
      const asksLine = (a.allow || a.deny || a.timeout || a.always)
        ? `\n批准卡结局：放行 ${a.allow ?? 0} · 总是允许 ${a.always ?? 0} · 本会话放行 ${a.allow_session ?? 0} · 拒绝 ${a.deny ?? 0} · 超时 ${a.timeout ?? 0}` : '';
      addSys(`累计 ${s.sessions ?? 0} 个会话 · ${s.messages ?? 0} 条消息（你发了 ${s.userMessages ?? 0} 条）· ${(s.tokens ?? 0).toLocaleString()} tok · $${s.cost ?? 0}`
        + (s.firstSession ? `——自 ${new Date(s.firstSession).toLocaleDateString()} 起` : '') + asksLine);
      // M75 process telemetry rides the same report — honest RSS/heap/uptime
      const m = await fetch('/api/metrics').then((x) => x.json()).catch(() => null);
      if (m?.bridge) {
        const mb = (b) => `${Math.round(b / 1048576)}MB`;
        addSys(`进程 — 桥 pid ${m.bridge.pid} · 运行 ${m.bridge.uptime_s}s · RSS ${mb(m.bridge.rss_bytes)} · 堆 ${mb(m.bridge.heap_used_bytes)}/${mb(m.bridge.heap_total_bytes)}`
          + (m.body ? ` · 身体 ${m.body.id} pid ${m.body.pid ?? '—'} ${m.body.alive ? '存活' : '已退出'}` : ''));
      }
    },
  },
  {
    cmd: '/config', label: '会话设置', hint: '/config 查看；/config key=value 设置（model/thinking/mode）',
    run: async (arg) => {
      const text = String(arg ?? '').trim();
      if (!text) {
        const r = await cmd('config_get');
        if (!r.success) { addSys(`读取失败：${r.error ?? '未知'}`, true); return; }
        const s = r.data ?? {};
        addSys(`当前设置 — 模型：${s.model?.id ?? s.model ?? '—'} · 思考：${s.thinking ?? '—'} · 模式：${s.mode ?? '—'}`);
        return;
      }
      const m = text.match(/^(\w+)\s*=\s*(.+)$/);
      if (!m) { addSys('用法：/config model=<provider/id 或别名> | thinking=<off|low|medium|high> | mode=<名>', true); return; }
      const r = await cmd('config_set', { key: m[1], value: m[2].trim() });
      if (!r.success) { addSys(`设置失败：${r.error ?? '未知'}`, true); return; }
      toast(`已设置 ${m[1]} = ${m[2].trim()}`);
      refreshState();
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
    // dedup-h #655 built-in deep research preset — the model expands the
    // bundled recipe through recipe_run, then orchestrates the angles.
    cmd: '/deep-research', label: '深度研究', hint: '/deep-research <主题>——多角度并行研究→markdown 报告',
    run: async (arg) => {
      const topic = String(arg ?? '').trim();
      if (!topic) { addSys('用法：/deep-research <主题>——拆成多角度并行后台研究再汇成报告', true); return; }
      input.value = `调用 recipe_run 工具运行内建配方 deep-research（参数 {"topic":${JSON.stringify(topic)}}），然后严格按照返回的配方指令执行编排。`;
      autogrow();
      await send();
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
    cmd: '/verify', label: '跑验证命令', hint: '手动触发 .pai/verify.json 的 onWrite 命令（Aider /lint /test 对等）',
    run: async () => {
      const r = await cmd('verify_run');
      if (!r.success) { addSys(`验证不可用：${r.error ?? '未知'}`, true); return; }
      const d = r.data ?? {};
      if (!d.ran) { addSys(`验证未运行：${d.reason ?? '未配置'}`, true); return; }
      addSys(`验证 ${d.ok ? '通过' : `失败（exit ${d.code}）`}：${(d.outputTail ?? '').split('\n').filter(Boolean).slice(-3).join(' / ') || '(无输出)'}`, !d.ok);
    },
  },
  {
    cmd: '/map', label: '仓库地图', hint: '源码文件+顶层符号的结构大纲（Aider /map 对等）',
    run: async (arg) => {
      const r = await cmd('repo_map', { subdir: arg.trim() || null });
      if (!r.success) { addSys(`repo map 不可用：${r.error ?? '未知'}`, true); return; }
      const d = r.data ?? {};
      addSys(`仓库地图：${d.files} 文件 / ${d.symbols} 符号${d.truncated ? '（截断）' : ''}`, false);
      addMsg('sys', `\`\`\`\n${d.text ?? '(空)'}\n\`\`\``);
    },
  },
  {
    cmd: '/skills', label: '技能体检', hint: '列出已加载 microagent 技能：大小/命中次数/启用态；/skills allow a,b 设白名单，/skills allow 清除',
    run: async (arg) => {
      const m = arg.trim().match(/^allow(?:\s+(.*))?$/);
      if (m) {
        const names = (m[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const r = await cmd('skill_allow_set', { names: names.length ? names : null });
        if (!r.success) { addSys(`白名单设置失败：${r.error ?? '未知'}`, true); return; }
        toast(r.data?.allow ? `技能白名单已设：${r.data.allow.join(', ')}` : '技能白名单已清除（全部启用）');
      }
      const r = await cmd('skills_list');
      if (!r.success) { addSys(`技能体检不可用：${r.error ?? '未知'}`, true); return; }
      const skills = r.data?.skills ?? [];
      if (!skills.length) { addSys('没有已加载的 microagent 技能（.pai/microagents/*.md 且带 triggers:）', false); return; }
      const lines = skills.map((s) =>
        `${s.allowed ? '●' : '○'} ${s.name} — ${s.bytes}B 注入成本 / 本轮命中 ${s.hits} 次 / 触发 ${s.triggers.slice(0, 4).join('、')}${s.triggers.length > 4 ? '…' : ''}${s.allowed ? '' : '（白名单外·停用中）'}`);
      addSys(`技能体检（${skills.filter((s) => s.allowed).length}/${skills.length} 启用）：\n${lines.join('\n')}`, false);
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
  { cmd: '/sessions', label: '对话列表', hint: '聚焦搜索框', run: () => { switchView('chat'); $('side-filter').focus(); } },
  { cmd: '/body', label: 'AI 引擎', hint: '查看与切换当前执行引擎', run: () => switchView('bodies') },
  { cmd: '/jobs', label: '后台任务', hint: '查看后台自动化任务与计划作业', run: () => switchView('jobs') },
  {
    cmd: '/worktree', label: 'worktree 管理', hint: '/worktree [命令]——裸用列出全部 git worktree（dedup-h #509 面板）；带命令则新建独立 worktree 跑后台任务',
    run: async (arg) => {
      const c = String(arg ?? '').trim();
      if (!c) {
        // bare form = the management pane: every linked checkout, managed flagged
        const r = await cmd('worktree_list');
        if (!r.success) { addSys(`worktree 列表失败：${r.error ?? '未知'}`, true); return; }
        const wts = r.data?.worktrees ?? [];
        if (!wts.length) { addSys('无 git worktree（或非 git 仓库）', true); return; }
        addSys(`git worktrees（${wts.length}）— /worktree-open <路径|名> <命令> 在其中开任务：\n` +
          wts.map((w) => `  ${w.managed ? '🛠' : '📁'} ${w.path}${w.branch ? `  [${w.branch}]` : ''}${w.detached ? '  (detached)' : ''}${w.managed ? '  (任务托管)' : ''}`).join('\n'), true);
        return;
      }
      const r = await cmd('job_spawn', { command: c, worktree: true });
      if (r.success) { toast(`worktree 任务已开：${r.data?.jobId ?? ''}`); switchView('jobs'); }
      else addSys(`worktree 任务失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    cmd: '/worktree-open', label: '打开既有 worktree', hint: '/worktree-open <路径|名> <命令>——在已存在的 git worktree 里跑后台任务（zed "open worktree in new window" 对等）',
    run: async (arg) => {
      const m = /^(\S+)\s+(.+)$/s.exec(String(arg ?? '').trim());
      if (!m) { toast('用法：/worktree-open <路径|名> <命令>', 'err'); return; }
      const r = await cmd('job_spawn', { command: m[2], in_worktree: m[1] });
      if (r.success) { toast(`已在 ${r.data?.workdir ?? m[1]} 开任务：${r.data?.jobId ?? ''}`); switchView('jobs'); }
      else addSys(`打开 worktree 失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    cmd: '/insights', label: '会话剖析', hint: '/insights [all|路径]——单会话分解+建议，all 聚合全部会话',
    run: async (arg) => {
      const a = String(arg ?? '').trim();
      // dedup-h #390 — aggregate mode: fleet stats across the session dir
      if (a === 'all' || a === '*') {
        const r = await cmd('session_insights', { all: true });
        if (!r.success) { addSys(`insights 失败：${r.error ?? '未知'}`, true); return; }
        const d = r.data ?? {};
        const top = (d.topTools ?? []).map((t) => `${t.name}×${t.count}`).join(' ') || '无';
        addSys([
          `📊 聚合剖析 ${d.sessions ?? 0} 个会话${d.unreadable?.length ? `（${d.unreadable.length} 个不可读）` : ''}`,
          `总消息 ${d.messages ?? 0} · 总 tokens ${d.tokens ?? 0} · 累计 $${d.cost ?? 0} · 错误块 ${d.errorBlocks ?? 0}`,
          `时长：均值 ${d.avgDurationMs != null ? `${Math.round(d.avgDurationMs / 60000)}min` : 'n/a'}${d.longest ? ` · 最长 ${Math.round(d.longest.durationMs / 60000)}min（${d.longest.file}）` : ''}`,
          `工具：${top}`,
          ...(d.tips ?? []).map((t) => `💡 ${t}`),
        ].join('\n'));
        return;
      }
      const p = a || currentSessionFile;
      if (!p) { toast('当前会话未落盘——/insights 需要文件会话', 'err'); return; }
      const r = await cmd('session_insights', { path: p });
      if (!r.success) { addSys(`insights 失败：${r.error ?? '未知'}`, true); return; }
      const d = r.data ?? {};
      const mins = d.durationMs != null ? `${Math.round(d.durationMs / 60000)}min` : 'n/a';
      const top = (d.topTools ?? []).map((t) => `${t.name}×${t.count}`).join(' ') || '无';
      addSys([
        `📊 会话剖析 ${d.file?.split(/[\\/]/).pop() ?? ''}`,
        `消息 ${d.messages}（user ${d.roles?.user ?? 0}/assistant ${d.roles?.assistant ?? 0}）· 时长 ${mins} · tokens ${d.tokens ?? 0} · $${d.cost ?? 0}`,
        `工具：${top}`,
        ...(d.tips ?? []).map((t) => `💡 ${t}`),
      ].join('\n'));
    },
  },
  {
    // dedup-h #391: MCP 服务器卡 — 状态 + OAuth 授权按钮（同一 PKCE 流程
    // 的 operator 面；verifier/state 留在宿主 pending map，不跨面）。
    cmd: '/mcp', label: 'MCP 服务器', hint: '/mcp——服务器状态 + OAuth 授权',
    run: async () => {
      const r = await cmd('mcp_status');
      if (!r.success) { addSys(`mcp 状态失败：${r.error ?? '未知'}`, true); return; }
      const d = r.data ?? {};
      const rows = d.servers ?? [];
      if (!rows.length) { addSys(`无 MCP 服务器配置（${d.configPath ?? '无配置文件'}）`); return; }
      const div = document.createElement('div');
      div.className = 'sys';
      for (const s of rows) {
        const line = document.createElement('div');
        const auth = s.oauth
          ? (s.authorized === 'self-refreshing' ? '· oauth 自刷新'
            : s.authorized ? '· 已授权' : '· 未授权')
          : '';
        line.textContent = `${s.name}  [${s.transport}]${auth}${s.oauthError ? ` · spec 错: ${s.oauthError}` : ''}`;
        div.appendChild(line);
        if (s.oauth === 'authorization_code' && s.authorized !== true) {
          const b = document.createElement('button');
          b.className = 'mcp-auth-btn';
          b.textContent = `🔐 授权 ${s.name}`;
          b.onclick = async () => {
            b.disabled = true;
            const a = await cmd('mcp_auth', { server: s.name });
            if (!a.success) { addSys(`授权失败：${a.error ?? '未知'}`, true); b.disabled = false; return; }
            addSys(`OAuth '${s.name}' — 在浏览器打开以下 URL 批准后粘贴 code（${a.data?.expiresInSec ?? 600}s 内有效）：\n${a.data?.url}`);
            const code = await askText(`完成 ${s.name} 授权`, '粘贴 authorization code');
            if (!code?.trim()) { b.disabled = false; return; }
            const fin = await cmd('mcp_auth_done', { server: s.name, code: code.trim() });
            if (fin.success) { addSys(`✅ ${s.name} 授权完成（refresh: ${fin.data?.refresh ? '有' : '无'}）——重启会话后工具调用自动携带`); }
            else addSys(`授权交换失败：${fin.error ?? '未知'}`, true);
            b.disabled = false;
          };
          div.appendChild(b);
        }
      }
      transcript.appendChild(div);
      scrollTail();
    },
  },
  {
    // dedup-h #19: project purge — inventory preview + per-category cleanup.
    // dry-run first, explicit confirm, evidence classes refused host-side.
    cmd: '/purge', label: '实例清理', hint: '/purge [exports|spool|sessions|tasks]——预览/清理实例产物（审计/记忆/回执不可清）',
    run: async (arg) => {
      const cat = String(arg ?? '').trim();
      if (!cat) {
        const inv = await cmd('instance_inventory');
        if (!inv.success) { addSys(`inventory 失败：${inv.error ?? '未知'}`, true); return; }
        const rows = Object.entries(inv.data?.categories ?? {})
          .map(([k, v]) => `${k}: ${v.files} 文件 ${(v.bytes / 1024).toFixed(1)}KB`);
        addSys(`实例产物分布（${inv.data?.root ?? ''}）：\n${rows.join('\n') || '（空）'}\n可清类别：exports / spool / sessions / tasks——/purge <类别>`);
        return;
      }
      const dry = await cmd('instance_purge', { category: cat, dry_run: true });
      if (!dry.success) { addSys(`清理预览失败：${dry.error ?? '未知'}`, true); return; }
      const d = dry.data ?? {};
      if (!confirm(`将永久删除 ${cat} 类 ${d.files ?? 0} 个文件（${((d.bytes ?? 0) / 1024).toFixed(1)}KB）。\n此操作不可撤销，确认执行？`)) return;
      const r = await cmd('instance_purge', { category: cat, dry_run: false });
      if (r.success) toast(`已清理 ${cat}：${r.data?.removed ?? 0} 个文件${r.data?.skipped ? `（跳过 ${r.data.skipped}）` : ''}`);
      else addSys(`清理失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    cmd: '/job', label: '后台跑命令', hint: '/job <命令>——durable job 后台执行（走 decide 治理链）',
    run: async (arg) => {
      const c = String(arg ?? '').trim();
      if (!c) { toast('用法：/job <命令>', 'err'); return; }
      const r = await cmd('job_spawn', { command: c });
      if (r.success) { toast(`后台任务已开：${r.data?.jobId ?? ''}`); switchView('jobs'); }
      else addSys(`后台任务失败：${r.error ?? '未知'}`, true);
    },
  },
  { cmd: '/changes', label: '文件变更', hint: '查看文件改动回执与导出产物', run: () => switchView('changes') },
  { cmd: '/audit', label: '安全日志', hint: '安全规则与治理事件流', run: () => switchView('audit') },
  { cmd: '/settings', label: '系统设置', hint: '模型密钥与工作目录', run: () => switchView('settings') },
  {
    cmd: '/clear', label: '清空开始', hint: '开启新对话（同 /new）', run: () => $('new-task').click(),
  },
  {
    // M81 named profiles: snapshot {model, thinking, mode} as a switchable pack
    cmd: '/profile', label: '配置档案', hint: '/profile save 名字 · /profile apply 名字 · /profile list · /profile del 名字 · /profile export|import 文件.json', run: async (arg) => {
      const [sub, ...rest] = arg.trim().split(/\s+/);
      const name = rest.join(' ');
      if (sub === 'save' && name) {
        const r = await cmd('profile_save', { name });
        if (r.success) toast(`档案「${name}」已保存`); else addSys(`保存失败：${r.error ?? '未知'}`, true);
        return;
      }
      if (sub === 'apply' && name) {
        const r = await cmd('profile_apply', { name });
        if (r.success) { toast(`已切到档案「${name}」`); refreshSessionsSoon(); }
        else addSys(`切换失败：${r.error ?? '未知'}`, true);
        return;
      }
      if (sub === 'del' && name) {
        await cmd('profile_delete', { name });
        toast(`档案「${name}」已删除`);
        return;
      }
      if (sub === 'export' || sub === 'import') {
        const r = await cmd(sub === 'export' ? 'profile_export' : 'profile_import', name ? { path: name } : {});
        if (r.success) toast(sub === 'export' ? `已导出 ${r.data?.path ?? ''}` : `已导入 ${r.data?.imported ?? 0} 个档案`);
        else addSys(`${sub} 失败：${r.error ?? '未知'}`, true);
        return;
      }
      const r = await cmd('profile_list');
      const rows = r.data ?? [];
      addSys(rows.length
        ? rows.map((p) => `${p.name} — ${p.model?.id ?? '模型未记'}${p.mode ? ` · ${p.mode}` : ''}${p.thinking ? ` · ${p.thinking}` : ''}`).join('\n')
        : '暂无档案——/profile save 名字 保存当前 模型/思考档/模式');
    },
  },
  {
    // M71: ephemeral session — in-memory only; nothing lands in the session
    // store, so it cannot be resumed, listed, or exported.
    cmd: '/eph', label: '临时会话', hint: '免持久化：不写盘、不可恢复', run: async () => {
      const r = await cmd('session_new', { ephemeral: true });
      if (r.success) {
        currentSessionFile = null;
        addSys('临时会话——本会话不落盘，关闭即消失', false);
        switchView('chat');
        $('input').focus();
      } else addSys(`临时会话失败：${r.error ?? '未知'}`, true);
    },
  },
  {
    // dedup-h #12: operator-pinned session id — UUID validated host-side,
    // collision with an existing file refused rather than adopted.
    cmd: '/newid', label: '指定 ID 新会话', hint: '/newid <uuid>——自定义会话 ID 开新会话',
    run: async (arg) => {
      const id = String(arg ?? '').trim();
      if (!id) { toast('用法：/newid <uuid>', 'err'); return; }
      const r = await cmd('session_new', { id });
      if (r.success) {
        addSys(`已开会话 ${r.data?.id ?? id}`, false);
        switchView('chat'); $('input').focus(); refreshSessions();
      } else addSys(`新建失败：${r.error ?? '未知'}`, true);
    },
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
    cmd: '/cost', label: '用量与成本', hint: '本会话 token/费用总账+预算余量',
    run: async () => {
      const [r, b] = await Promise.all([cmd('session_stats'), cmd('budget_status')]);
      const s = r.data;
      if (!s) { addSys('暂无用量数据', true); return; }
      const u = s.usage ?? s;
      const lines = [`累计：${u.totalTokens ?? u.tokens ?? '—'} tokens · $${(u.cost?.total ?? u.totalCost ?? sessionCost).toFixed ? (u.cost?.total ?? u.totalCost ?? sessionCost).toFixed(4) : '—'} · 消息 ${s.messageCount ?? '—'} 条 · 压缩 ${s.compactionCount ?? 0} 次`];
      const bd = b?.data;
      if (bd?.configured) {
        const parts = [];
        if (bd.limits?.maxTokensPerSession) parts.push(`tokens ${bd.consumed?.tokens ?? 0}/${bd.limits.maxTokensPerSession}`);
        if (bd.limits?.maxCostPerSessionUsd) parts.push(`$${(bd.consumed?.cost ?? 0).toFixed(4)}/$${bd.limits.maxCostPerSessionUsd}`);
        if (bd.limits?.maxCallsPerSession) parts.push(`calls ${bd.consumed?.calls ?? 0}/${bd.limits.maxCallsPerSession}`);
        lines.push(`预算：${parts.join(' · ') || '已配置'}`);
      } else lines.push('预算：未配置限额（设置 → 预算上限 可配）');
      // 历史趋势：TURN_ACCOUNTING 事件跨日聚合（按天 + 按模型）。
      // 审计日志是计费的唯一权威账本——会话 rewind 不会抹掉已花掉的 token。
      const hist = await cmd('audit_tail', { n: 5000 });
      const evs = Array.isArray(hist.data) ? hist.data : (hist.data?.events ?? []);
      const accts = evs.filter((e) => e.kind === 'TURN_ACCOUNTING');
      if (accts.length) {
        const byDay = new Map(); const byModel = new Map();
        for (const e of accts) {
          const day = String(e.ts ?? e.time ?? '').slice(0, 10) || '未知日期';
          const tok = e.data?.totalTokens ?? ((e.data?.input ?? 0) + (e.data?.output ?? 0));
          const cost = e.data?.cost?.total ?? e.data?.cost ?? 0;
          const d = byDay.get(day) ?? { tok: 0, cost: 0, n: 0 };
          d.tok += tok; d.cost += cost; d.n += 1; byDay.set(day, d);
          const m = e.data?.model ?? '（旧记录无模型字段）';
          const mm = byModel.get(m) ?? { tok: 0, cost: 0 };
          mm.tok += tok; mm.cost += cost; byModel.set(m, mm);
        }
        const days = [...byDay.entries()].sort().slice(-7);
        lines.push('近 ' + days.length + ' 天：' + days.map(([day, d]) => `${day.slice(5)} ${d.tok}tok/$${d.cost.toFixed(4)}`).join(' · '));
        const models = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 4);
        lines.push('按模型：' + models.map(([m, d]) => `${m} $${d.cost.toFixed(4)}`).join(' · '));
        if (hist.data?.hasMore) lines.push('（还有更早的账本——审计页可继续向前翻）');
      }
      addSys(lines.join('\n'));
    },
  },
  {
    cmd: '/doctor', label: '配置检视', hint: '有效姿态一览——模式/政策/记忆/目标/自动化配置（agent debug 对等）',
    run: async () => {
      const [st, pol, modes, mem, aliases, ver] = await Promise.all([
        cmd('get_state'), cmd('policy_status'), cmd('mode_list'), cmd('memory_stats'), cmd('model_alias_list'), cmd('verify_status'),
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
        `验证回路：${ver.success ? (ver.data?.configured === false ? '未配 verify.json' : `已配置 · ${ver.data?.lastResult ?? ver.data?.status ?? '就绪'}`) : '不可用'}`,
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
  const text = await askText('记住什么？', '一句话事实/偏好/决定');
  if (!text?.trim()) return;
  const r = await cmd('memory_save', { text: text.trim() });
  if (r.success) { toast('已记住'); refreshMemory(); }
  else toast(`写入被拒：${r.error ?? '未知'}`, 'err');
};
// 记忆整理回路（memory_distill 接线）：确定性维护——合并重复、降权陈旧、
// 归档古老低置信条目；不做任何 LLM 发明或提升。
$('mem-distill-btn').onclick = async () => {
  const msg = $('mem-distill-msg');
  const r = await cmd('memory_distill');
  if (!r.success) { if (msg) { msg.textContent = `整理失败：${r.error ?? '未知'}`; msg.className = 'setup-msg err'; } return; }
  const d = r.data ?? {};
  if (msg) {
    msg.textContent = `整理完成：归档 ${d.archived ?? 0} · 降权 ${d.demoted ?? 0} · 合并 ${d.merged ?? 0}`;
    msg.className = 'setup-msg ok';
  }
  refreshMemory();
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

/* M127: fuzzy subsequence match — needle chars must appear in order;
   score rewards contiguity, prefix hits and shorter targets. -1 = no match. */
function fuzzyScore(needle, hay) {
  if (!needle) return 0;
  const n = needle.toLowerCase(), h = String(hay ?? '').toLowerCase();
  let i = 0, best = 0, run = 0;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) { i++; run++; if (run > best) best = run; }
    else run = 0;
  }
  if (i < n.length) return -1;
  return n.length * 2 + best * 3 + (h.startsWith(n) ? 10 : 0) - h.length * 0.01;
}

function slashFilter() {
  const v = input.value;
  // @file-ref autocomplete: a @token anywhere (start or after whitespace)
  const upto = v.slice(0, input.selectionStart);
  const m = upto.match(/(?:^|\s)@([\w./\\-]*)$/);
  if (m) { atComplete(m, input.selectionStart); return; }
  atToken = null;
  if (!v.startsWith('/') || v.includes('\n')) { closeSlash(); return; }
  const head = v.slice(1).split(/\s+/)[0].toLowerCase();
  const scored = [];
  for (const s of SLASH) {
    const sc = Math.max(fuzzyScore(head, s.cmd.slice(1)), fuzzyScore(head, s.label) - 1);
    if (sc >= 0) scored.push({ s, sc });
  }
  for (const n of Object.keys(MACROS)) {
    const sc = fuzzyScore(head, n);
    if (sc >= 0) scored.push({ s: { cmd: `/${n}`, label: '宏', hint: MACROS[n].slice(0, 60), macro: MACROS[n] }, sc });
  }
  // session jump: fuzzy over session names/first messages — only when the
  // user typed a head, capped so commands stay reachable
  if (head) {
    let sessCount = 0;
    for (const s of sessionsCache) {
      if (sessCount >= 6) break;
      const sc = fuzzyScore(head, `${s.name ?? ''} ${s.firstMessage ?? ''}`);
      if (sc >= 0) {
        scored.push({ s: { cmd: '💬', label: (s.name || s.firstMessage || '会话').slice(0, 42), hint: '切换到会话', session: s.path }, sc: sc - 2 });
        sessCount++;
      }
    }
  }
  scored.sort((a, b) => b.sc - a.sc);
  slashItems = scored.slice(0, 24).map((x) => x.s);
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

/* Ctrl+R — fuzzy reverse-search over prompt history (readline analogue).
 * The composer doubles as the query box; matches render newest-first in the
 * slash-menu overlay; Enter recalls, Esc restores the draft. */
let histSearch = null; // {draft}
function histMatches(q) {
  const needle = q.toLowerCase();
  const seen = new Set();
  const out = [];
  for (let i = promptHist.length - 1; i >= 0 && out.length < 12; i--) {
    const h = promptHist[i];
    if (seen.has(h)) continue;
    if (!needle || h.toLowerCase().includes(needle)) { seen.add(h); out.push(h); }
  }
  return out;
}
function openHistSearch() {
  histSearch = { draft: input.value };
  slashFilterHist();
}
function slashFilterHist() {
  if (!histSearch) return;
  slashItems = histMatches(input.value.trim());
  slashIdx = 0;
  slashMenu.innerHTML = '';
  if (!slashItems.length) {
    const b = document.createElement('button');
    b.className = 'slash-item';
    b.innerHTML = '<span class="sl-label"></span>';
    b.querySelector('.sl-label').textContent = '（无匹配历史）';
    slashMenu.appendChild(b);
    slashMenu.classList.remove('hidden');
    return;
  }
  slashItems.forEach((h, i) => {
    const b = document.createElement('button');
    b.className = `slash-item${i === slashIdx ? ' sel' : ''}`;
    b.innerHTML = '<span class="sl-cmd"></span><span class="sl-label"></span>';
    b.querySelector('.sl-cmd').textContent = '⏪';
    b.querySelector('.sl-label').textContent = h.length > 80 ? `${h.slice(0, 80)}…` : h;
    b.onmouseenter = () => { slashIdx = i; paintSlashSel(); };
    b.onclick = () => pickHist(h);
    slashMenu.appendChild(b);
  });
  slashMenu.classList.remove('hidden');
}
function pickHist(h) {
  pushDraft(); input.value = h; histSearch = null; closeSlash(); autogrow();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
function cancelHistSearch() {
  pushDraft(); input.value = histSearch?.draft ?? '';
  histSearch = null; closeSlash(); autogrow();
}
async function execSlash(s) {
  // session-jump entries switch sessions instead of running a command
  if (s.session) {
    const target = s.session;
    closeSlash();
    pushDraft(); input.value = ''; autogrow();
    await switchSession(target);
    return;
  }
  // file-ref / macro entries edit the draft, not execute a command
  if (s.file && atToken) {
    const v = input.value;
    pushDraft();
    input.value = v.slice(0, atToken.start) + `@${s.file} ` + v.slice(atToken.end);
    input.selectionStart = input.selectionEnd = atToken.start + s.file.length + 2;
    closeSlash(); autogrow(); input.focus();
    return;
  }
  if (s.macro != null) {
    closeSlash();
    pushDraft(); input.value = s.macro; autogrow(); input.focus();
    return;
  }
  const arg = input.value.slice(1).split(/\s+/).slice(1).join(' ').trim();
  closeSlash();
  pushDraft(); input.value = ''; autogrow();
  await s.run(arg);
}

/* Per-session composer drafts (PI reference): text survives session
 * switches — keyed by session file, cleared on send. */
/* ---------- M126: draft-level undo/redo ----------
   Native textarea undo dies at every programmatic set (send clear, slash
   exec, history recall, rewind restore, quote insert). This stack snapshots
   the draft at those boundaries plus typing pauses; Ctrl+Z / Ctrl+Shift+Z
   (or Ctrl+Y) walk it. */
const draftUndo = [], draftRedo = [];
let prevDraft = '', draftLastPush = 0;
const draftKey = () => `pai.draft.${currentSessionFile ?? 'new'}`;
function loadDraft() {
  input.value = localStorage.getItem(draftKey()) ?? '';
  draftUndo.length = 0; draftRedo.length = 0; prevDraft = input.value;
  autogrow();
}
function pushDraft(v = input.value) {
  if (draftUndo[draftUndo.length - 1] === v) return;
  draftUndo.push(v);
  if (draftUndo.length > 200) draftUndo.shift();
  draftRedo.length = 0;
}
input.addEventListener('input', () => {
  autogrow();
  if (histSearch) slashFilterHist(); else slashFilter();
  localStorage.setItem(draftKey(), input.value);
  if (Date.now() - draftLastPush > 700) { draftLastPush = Date.now(); pushDraft(prevDraft); }
  prevDraft = input.value;
});
input.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) {
    if (!draftUndo.length) return; // no snapshot — let native undo try
    e.preventDefault();
    const cur = input.value;
    let prev = draftUndo.pop();
    if (prev === cur && draftUndo.length) prev = draftUndo.pop();
    if (prev === cur) { draftUndo.push(prev); return; }
    draftRedo.push(cur);
    input.value = prev; prevDraft = prev;
    autogrow(); if (histSearch) slashFilterHist(); else slashFilter();
  } else if ((k === 'z' && e.shiftKey) || k === 'y') {
    if (!draftRedo.length) return;
    e.preventDefault();
    draftUndo.push(input.value);
    input.value = draftRedo.pop(); prevDraft = input.value;
    autogrow(); if (histSearch) slashFilterHist(); else slashFilter();
  }
});
input.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault();
    if (histSearch) { cancelHistSearch(); } else { openHistSearch(); }
    return;
  }
  if (histSearch) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = Math.min(slashIdx + 1, slashItems.length - 1); paintSlashSel(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = Math.max(slashIdx - 1, 0); paintSlashSel(); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancelHistSearch(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (slashItems.length) pickHist(slashItems[slashIdx]);
      else cancelHistSearch();
      return;
    }
  }
  if (!slashMenu.classList.contains('hidden')) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = (slashIdx + 1) % slashItems.length; paintSlashSel(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = (slashIdx - 1 + slashItems.length) % slashItems.length; paintSlashSel(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); execSlash(slashItems[slashIdx]); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); busy ? steer() : send(); return; }
  // Esc interrupts a running turn (every harness: Esc = abort); with queued
  // prompts waiting, a second Esc within 1.5s drops the tail — aborting the
  // run must not silently eat messages the operator typed deliberately, so
  // queue-clear is a separate deliberate keystroke, not bundled into abort.
  if (e.key === 'Escape' && busy) { e.preventDefault(); abort(); lastEscAt = Date.now(); return; }
  if (e.key === 'Escape' && queue.length && Date.now() - lastEscAt < 1500) {
    e.preventDefault();
    const n = queue.length; queue.length = 0; renderQueue();
    toast(`已弃尾 ${n} 条排队消息`, 'info'); lastEscAt = 0; return;
  }
  if (e.key === 'Escape') lastEscAt = Date.now();
  // dedup-h #303 — ArrowUp queue-edit: while queued messages wait, the
  // most recent one pulls back into the composer for editing (CC queue-
  // edit UX). Same guard as history recall — never clobbers mid-typing;
  // image attachments are restored onto the attach row with it.
  if (e.key === 'ArrowUp' && queue.length && (!input.value.trim() || histIdx >= 0)) {
    e.preventDefault();
    const q = queue.pop(); renderQueue();
    if (histIdx < 0) pushDraft();
    for (const a of q.attachments ?? []) {
      pendingAttach.push({
        name: a.name,
        kind: String(a.mime ?? '').startsWith('image/') ? 'image' : 'media',
        data: a.data, mimeType: a.mime, bytes: a.bytes,
      });
    }
    if (q.attachments?.length) renderAttach();
    // restore what the operator TYPED, not the expanded outbound — @mention
    // and file folds re-expand on resend anyway
    input.value = q.typed ?? q.label ?? q.text; prevDraft = input.value; autogrow();
    return;
  }
  // ArrowUp/Down walk prompt history when the composer is empty or already
  // showing a recalled entry (shell-style; draft text is preserved).
  if (e.key === 'ArrowUp' && promptHist.length
      && (!input.value.trim() || histIdx >= 0)) {
    e.preventDefault();
    if (histIdx < 0) pushDraft();
    if (histIdx < promptHist.length - 1) histIdx++;
    input.value = promptHist[promptHist.length - 1 - histIdx]; prevDraft = input.value; autogrow(); return;
  }
  if (e.key === 'ArrowDown' && histIdx >= 0) {
    e.preventDefault();
    histIdx--;
    input.value = histIdx >= 0 ? promptHist[promptHist.length - 1 - histIdx] : '';
    autogrow(); return;
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
let lastEscAt = 0; // double-Esc window for queue-tail drop
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
/* dedup-h #143 — model-invoked builtin commands. session_command emits a
 * command_request event; the surface queues it behind any operator prompt
 * already waiting, then runs the SAME path as the operator's slash command.
 * Deduped by (name,arg); order preserved. */
const sessionCmdQueue = [];
function queueSessionCommand(name, arg) {
  name = String(name ?? ''); arg = String(arg ?? '');
  if (sessionCmdQueue.some((c) => c.name === name && c.arg === arg)) return;
  sessionCmdQueue.push({ name, arg });
  drainSessionCmds();
}
async function drainSessionCmds() {
  if (busy || queue.length || !sessionCmdQueue.length) return;
  while (sessionCmdQueue.length && !busy && !queue.length) {
    const c = sessionCmdQueue.shift();
    addSys(`模型请求执行 /${c.name}${c.arg ? ` ${c.arg}` : ''}`);
    try { await runSessionCommand(c.name, c.arg); }
    catch (e) { addSys(`命令执行失败：${e?.message ?? e}`, true); }
  }
}
async function runSessionCommand(name, arg) {
  const slash = (c) => SLASH.find((s) => s.cmd === c);
  switch (name) {
    case 'clear': return slash('/clear')?.run('');
    case 'new': {
      // dedup-h #571 Cline new_task analogue: fresh session, then the
      // model's handoff briefing is sent through the SAME prompt path an
      // operator message takes (mention expansion, transcript, decide chain).
      const r = await cmd('session_new');
      if (!r.success) { addSys(`新建会话失败：${r.error ?? '未知'}`, true); return; }
      switchView('chat');
      if (arg) { queue.push({ text: arg, label: arg, typed: arg }); await flushQueue(); }
      return;
    }
    case 'config': return slash('/config')?.run(arg);
    case 'model': {
      if (!arg) return slash('/model')?.run('');
      const m = arg.match(/^([^\s/]+)\/(\S+)$/);
      const r = m ? await cmd('model_set', { provider: m[1], model: m[2] }) : await cmd('model_set', { alias: arg });
      if (!r.success) { addSys(`模型切换失败：${r.error ?? '未知'}`, true); return; }
      toast(`模型已切换：${arg}`);
      refreshState();
      return;
    }
    case 'resume': {
      if (!arg) return slash('/resume')?.run('');
      const r = await cmd('session_list');
      const rows = r.data ?? [];
      const needle = arg.toLowerCase();
      const t = rows.find((s) => s.id === arg)
        ?? rows.find((s) => (s.name ?? '').toLowerCase().includes(needle))
        ?? rows.find((s) => (s.firstMessage ?? '').toLowerCase().includes(needle));
      if (!t) { addSys(`找不到会话「${arg}」`, true); return; }
      return switchSession(t.path);
    }
  }
}
async function flushQueue() {
  const next = queue.shift();
  renderQueue();
  if (!next) return;
  lastUserText = next.label ?? next.text;
  histPush(next.label ?? next.text);
  addMsg('user', next.label ?? next.text);
  const ex = await expandAtMentions(next.text);
  if (ex.missed.length) addSys(`未能读取：${ex.missed.join('、')}（请确认路径在 workdir 内）`, true);
  cmd('prompt', { message: ex.text, ...(next.attachments?.length ? { options: { attachments: next.attachments } } : {}) }).then((r) => {
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
    // M129: path:line references detected inside the paste ride the chip as
    // a badge so the operator can see what the wall of text points at.
    if (a.refs?.length) {
      const badge = document.createElement('span');
      badge.className = 'attach-refs';
      badge.textContent = `📍 ${a.refs[0]}${a.refs.length > 1 ? ` +${a.refs.length - 1}` : ''}`;
      badge.title = a.refs.join('\n');
      chip.insertBefore(badge, chip.querySelector('.attach-x'));
    }
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
    // M129: recognise `path:line(:col)` references inside the paste so the
    // chip can badge what it points at (stack traces, grep output, editor
    // copy-all with headers).
    const refs = [...new Set(
      [...t.matchAll(/([\w./\\-]{2,}\.(?:js|jsx|ts|tsx|mjs|cjs|py|pyi|java|go|rs|c|cc|cpp|h|hpp|cs|css|scss|html|vue|svelte|md|json|jsonc|ya?ml|toml|ini|sql|sh|bash|bat|ps1|rb|php|swift|kt|kts|lua|pl|ex|exs|erl|hs|clj|scala|xml))[:：](\d{1,7})(?::\d{1,7})?/g)]
        .map((mm) => `${mm[1]}:${mm[2]}`),
    )].slice(0, 8);
    const a = { name: `粘贴文本-${new Date().toTimeString().slice(0, 8).replaceAll(':', '')}.txt`, kind: 'text', text: t, bytes: t.length };
    if (refs.length) a.refs = refs;
    pendingAttach.push(a);
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
  pushDraft(); input.value = ''; autogrow();
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
  if (busy) { queue.push({ text: message, attachments, label: text || `（${attachCount} 个附件）`, typed: text }); renderQueue(); return; }
  lastUserText = text;
  histPush(text);
  addMsg('user', text || `（${attachCount} 个附件）`);
  const ex = await expandAtMentions(message);
  if (ex.attached.length) addSys(`已附着 ${ex.attached.length} 个文件：${ex.attached.join('、')}`);
  if (ex.missed.length) addSys(`未能读取：${ex.missed.join('、')}（请确认路径在 workdir 内）`, true);
  const r = await cmd('prompt', { message: ex.text, ...(attachments.length ? { options: { attachments } } : {}) });
  if (!r.success) {
    const err = r.error ?? '未知';
    addSys(`发送失败：${err}${/budget/i.test(err) ? '——预算是按会话计的：「新建任务」开新会话即恢复，或去「设置 → 预算上限」调高限额' : ''}`, true);
  }
}
async function steer() {
  const text = input.value.trim();
  if (!text) return;
  closeSlash();
  pushDraft(); input.value = ''; autogrow();
  localStorage.removeItem(draftKey());
  const r = await cmd('steer', { message: text });
  if (!r.success) addSys(`插话失败：${r.error ?? '未知'}`, true);
}
$('send').onclick = () => (busy ? steer() : send());
$('steer').onclick = steer;
for (const b of document.querySelectorAll('.starter')) {
  b.onclick = () => { pushDraft(); input.value = b.dataset.q; autogrow(); input.focus(); };
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
  // While the operator is paging back through history, a live event must not
  // yank the view back to page one — they can return via the view switch.
  if (auditSeen > 200) return;
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
  loadDraft(); // refreshState learned currentSessionFile — restore its draft
  await replayHistory(); // reopened app should show the persisted session, not blank
  await refreshPending();
})();

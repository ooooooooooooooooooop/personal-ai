import { sendCmd } from './api';

/**
 * 健康探测：侧栏状态行与健康页共用同一份结论，两处说法不会打架。
 * 只陈述真实取得的状态；未取得 = 未知（PRD P05：不把未知与陈旧显示成正常）。
 * 每项回答"它正常吗？不正常怎么办"，用人话，不暴露内部概念。
 *
 * tone: ok | warn | err | info | unknown
 * action: { kind: 'run', cmd, args, label } 真实命令 | { kind: 'nav', view, label } 去处理的页面
 */
export function relTime(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts ?? '');
  if (!Number.isFinite(t)) return null;
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

const LANE_NAMES = { frequent: '日常', 'sync-check': '同步', weekly: '每周' };

export async function probeHealth() {
  const [sup, bk, gov, wm] = await Promise.all([
    sendCmd('supervisor_status'),
    sendCmd('backup_status'),
    sendCmd('governance_status'),
    sendCmd('world_model_status', { limit: 1 }),
  ]);
  let api = null;
  try {
    const r = await fetch('/api/health');
    if (r.ok) api = await r.json();
  } catch { api = null; }

  const items = [];

  // AI 引擎连接
  if (!sup.success) {
    items.push({ id: 'engine', name: 'AI 引擎', tone: 'err', text: '应用后台无法连接', detail: sup.error });
  } else if (sup.data?.switching) {
    items.push({ id: 'engine', name: 'AI 引擎', tone: 'info', text: '正在切换引擎…' });
  } else if (!sup.data?.active) {
    items.push({
      id: 'engine', name: 'AI 引擎', tone: 'err', text: '没有运行中的引擎',
      action: { kind: 'nav', view: 'engine', label: '去启动' },
    });
  } else {
    items.push({
      id: 'engine',
      name: 'AI 引擎',
      tone: 'ok',
      text: `${sup.data.active} 运行中`,
    });
  }

  // 备份（backup_status {force:true} 会立即探测，逾期时真实执行一次备份）
  const b = bk.success ? bk.data : null;
  const runBackup = { kind: 'run', cmd: 'backup_status', args: { force: true }, label: '立即备份' };
  if (!bk.success) {
    items.push({ id: 'backup', name: '备份', tone: 'err', text: '读不到备份状态', detail: bk.error });
  } else if (b?.running) {
    items.push({ id: 'backup', name: '备份', tone: 'info', text: '正在备份…' });
  } else if (b?.ok === undefined) {
    items.push({ id: 'backup', name: '备份', tone: 'unknown', text: '尚未检查', action: { ...runBackup, label: '立即检查' } });
  } else if (!b.ok) {
    items.push({ id: 'backup', name: '备份', tone: 'err', text: '备份检查失败', detail: b.error, action: { ...runBackup, label: '重试' } });
  } else if (b.overdue) {
    const last = b.last_ok ? `上次成功 ${relTime(b.last_ok)}` : '从未成功备份';
    items.push({ id: 'backup', name: '备份', tone: 'warn', text: `备份已逾期（${last}）`, action: runBackup });
  } else {
    items.push({ id: 'backup', name: '备份', tone: 'ok', text: b.last_ok ? `上次备份 ${relTime(b.last_ok)}` : '备份正常' });
  }

  // 自动自检（治理巡检 lanes）
  const g = gov.success ? gov.data : null;
  const runGov = { kind: 'run', cmd: 'governance_status', args: { force: true }, label: '立即检查' };
  if (!gov.success) {
    items.push({ id: 'checks', name: '自动自检', tone: 'err', text: '读不到自检状态', detail: gov.error });
  } else if (g?.running) {
    items.push({ id: 'checks', name: '自动自检', tone: 'info', text: '正在自检…' });
  } else if (g?.ok === undefined) {
    items.push({ id: 'checks', name: '自动自检', tone: 'unknown', text: '尚未检查', action: runGov });
  } else if (!g.ok) {
    items.push({ id: 'checks', name: '自动自检', tone: 'err', text: '自检运行失败', detail: g.error, action: { ...runGov, label: '重试' } });
  } else {
    const lanes = g.lanes ?? {};
    const due = Object.keys(lanes).filter((l) => lanes[l]?.overdue).map((l) => LANE_NAMES[l] ?? l);
    const last = Object.values(lanes).map((l) => l?.last_ok).filter(Boolean).sort().pop();
    if (due.length) {
      items.push({ id: 'checks', name: '自动自检', tone: 'warn', text: `${due.join('、')}自检已逾期`, action: runGov });
    } else {
      items.push({ id: 'checks', name: '自动自检', tone: 'ok', text: last ? `上次自检 ${relTime(last)}` : '自检正常' });
    }
  }

  // 跨设备同步（只读：同步由同步链在本机命令行执行，界面不发明新口子）
  const cp = api?.checkpoint;
  if (!api) {
    items.push({ id: 'sync', name: '跨设备同步', tone: 'unknown', text: '读不到同步记录' });
  } else if (!cp?.last_sync) {
    items.push({ id: 'sync', name: '跨设备同步', tone: 'info', text: '这台设备还没有同步记录' });
  } else {
    const pending = Object.values(cp.per_repo_sync_state ?? {}).some((s) => s && s !== 'IN_SYNC');
    items.push({
      id: 'sync', name: '跨设备同步',
      tone: pending ? 'info' : 'ok',
      text: `上次同步 ${relTime(cp.last_sync)}${pending ? '，本机有改动尚未同步' : ''}`,
    });
  }

  // 认知（AI 当前信什么）
  if (!wm.success) {
    items.push({ id: 'cognition', name: '认知', tone: 'err', text: '读不到认知状态', detail: wm.error });
  } else if (wm.data?.briefing) {
    const at = wm.data.runtimeState?.compiled_at;
    items.push({ id: 'cognition', name: '认知', tone: 'ok', text: at ? `认知已更新（${relTime(at)}）` : '认知已就绪' });
  } else {
    items.push({ id: 'cognition', name: '认知', tone: 'info', text: '还没有形成认知简报', action: { kind: 'nav', view: 'cognition', label: '去查看' } });
  }

  // 代码版本：仓库已更新但运行的还是旧代码（不是故障，重启即生效）
  if (sup.success && sup.data?.version?.stale) {
    items.push({ id: 'version', name: '应用版本', tone: 'info', text: '有新版本，重启应用后生效' });
  }

  const has = (t) => items.some((i) => i.tone === t);
  const overall = has('err') ? 'err' : has('warn') ? 'warn' : items.every((i) => i.tone === 'unknown') ? 'unknown' : 'ok';
  const problems = items.filter((i) => i.tone === 'err' || i.tone === 'warn');
  const label = overall === 'ok'
    ? '一切正常'
    : overall === 'unknown'
    ? '正在检查…'
    : `${problems[0].name}：${problems[0].text}${problems.length > 1 ? ` 等 ${problems.length} 项` : ''}`;

  return { items, problems, overall, label, at: Date.now() };
}

export async function runHealthAction(action) {
  if (action?.kind !== 'run') return { success: false, error: 'not a runnable action' };
  return sendCmd(action.cmd, action.args ?? {});
}

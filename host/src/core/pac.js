/**
 * pac.js — dedup-h #727: PAC (Proxy Auto-Config) + WPAD proxy discovery.
 *
 * Zero-dependency host module. A PAC script is a remote-controlled piece of
 * code — it runs inside node:vm with ONLY the standard FindProxyForURL
 * helper surface; it gets no require, no timers, no globals, and a bounded
 * execution timeout. The script source is fetched with byte/time caps.
 *
 * Honest mapping onto the env-proxy surface: undici's env proxy can express
 * exactly ONE proxy plus a NO_PROXY bypass list. resolvePacProxy therefore
 * evaluates FindProxyForURL for every probe host and:
 *   - unanimous "PROXY h:p"      → that proxy; hosts answering DIRECT join
 *                                  the noProxy list (expressible faithfully)
 *   - unanimous DIRECT           → no proxy (PAC says go direct)
 *   - differing proxies / SOCKS  → refuse to apply (env surface cannot
 *                                  express per-host proxies; never flatten
 *                                  silently) — surfaced as conflict
 *   - fetch/eval failure         → error result, caller applies nothing
 *
 * dnsResolve inside PAC scripts resolves ONLY the names we pre-resolved for
 * the caller (the probe hosts themselves + wpad); Node offers no sync DNS —
 * a PAC that resolves arbitrary names gets null → isResolvable=false.
 * That is the documented boundary, matching browser behavior for names the
 * resolver cannot answer.
 */
import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import vm from 'node:vm';

export const PAC_MAX_BYTES = 256 * 1024;
export const PAC_FETCH_TIMEOUT_MS = 3000;
export const PAC_EVAL_TIMEOUT_MS = 200;

/** Standard PAC helper implementation (Mozilla spec subset, zero-dep). */
function helperSource({ resolveMap, myIp, alerts }) {
  const resMap = Object.fromEntries(Object.entries(resolveMap ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const dnsResolve = (h) => resMap[String(h).toLowerCase()] ?? null;
  const ipToLong = (ip) => ip.split('.').reduce((a, o) => ((a << 8) | (Number(o) & 255)) >>> 0, 0);
  const shExp = (str, pat) => {
    const re = new RegExp('^' + String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return re.test(String(str));
  };
  return {
    isPlainHostName: (h) => !String(h).includes('.'),
    dnsDomainIs: (h, d) => String(h).toLowerCase().endsWith(String(d).toLowerCase()),
    localHostOrDomainIs: (h, hd) => String(h).toLowerCase() === String(hd).toLowerCase()
      || (String(hd).indexOf('.') === -1 && String(h).toLowerCase().startsWith(String(hd).toLowerCase() + '.')),
    isResolvable: (h) => dnsResolve(h) != null,
    isInNet: (h, pattern, mask) => {
      const ip = dnsResolve(h);
      if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
      return (ipToLong(ip) & ipToLong(mask)) >>> 0 === ipToLong(pattern);
    },
    dnsResolve,
    myIpAddress: () => myIp ?? '127.0.0.1',
    dnsDomainLevels: (h) => String(h).split('.').length - 1,
    shExpMatch: shExp,
    alert: (m) => { if (alerts.length < 16) alerts.push(String(m).slice(0, 300)); },
    // Date/time conditions — local time (GMT suffix honored by parsing in UTC)
    weekdayRange: (...a) => dateCond(a, 'wd'),
    dateRange: (...a) => dateCond(a, 'd'),
    timeRange: (...a) => dateCond(a, 't'),
  };
}

const WD = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function dateCond(args, kind) {
  const gmt = args[args.length - 1] === 'GMT';
  const a = gmt ? args.slice(0, -1) : args;
  const now = new Date();
  const g = (f) => gmt ? now[`getUTC${f}`]() : now[`get${f}`]();
  if (kind === 'wd') {
    const day = g('Day');
    const days = a.filter((x) => x !== undefined).map((x) => WD[String(x).toUpperCase().slice(0, 3)]).filter((x) => x != null);
    return days.length === 1 ? day === days[0] : day >= days[0] && day <= days[days.length - 1];
  }
  const ord = a.map((x) => typeof x === 'string' && MON[String(x).toUpperCase().slice(0, 3)] != null ? MON[String(x).toUpperCase().slice(0, 3)] : Number(x));
  if (kind === 'd') {
    // dateRange(d1[,m1,y1][,d2,m2,y2]) — day / day+month / full range
    const cur = [g('Date'), g('Month'), g('FullYear')];
    const key = (d, m, y) => (y ?? cur[2]) * 372 + (m ?? cur[1]) * 31 + d;
    const ck = cur[2] * 372 + cur[1] * 31 + cur[0];
    if (ord.length <= 3) {
      if (ord.length === 1) return cur[0] === ord[0];
      if (ord.length === 2) return cur[1] === ord[1];
      return ck === key(ord[0], ord[1], ord[2]);
    }
    const lo = key(ord[0], ord[1], ord[2]), hi = key(ord[3], ord[4], ord[5]);
    return ck >= lo && ck <= hi;
  }
  // timeRange(h1[,m1,s1][,h2,m2,s2])
  const cs = g('Hours') * 3600 + g('Minutes') * 60 + g('Seconds');
  const sec = (i) => (ord[i] ?? 0) * 3600 + (ord[i + 1] ?? 0) * 60 + (ord[i + 2] ?? 0);
  if (a.length === 1) return g('Hours') === ord[0];
  const lo = sec(0), hi = a.length > 3 ? sec(3) : sec(0) + 3600;
  return cs >= lo && cs < hi;
}

/** First non-internal IPv4 — myIpAddress() source. */
export function localIpv4() {
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Evaluate FindProxyForURL for one (url, host) inside a vm sandbox.
 * @returns {{result:string, alerts:string[]}} — the PAC return string
 */
export function evaluatePac(pacSource, url, host, { resolveMap = {}, myIp = null } = {}) {
  if (typeof pacSource !== 'string' || !pacSource.trim()) return { error: 'empty PAC script' };
  const alerts = [];
  const helpers = helperSource({ resolveMap, myIp: myIp ?? localIpv4(), alerts });
  const sandbox = Object.create(null);
  Object.assign(sandbox, helpers);
  try {
    // one evaluation: the script defines FindProxyForURL, the trailing call
    // is the completion value — running the source twice would replay any
    // side effects and double the eval-time budget
    const result = vm.runInNewContext(
      `${pacSource}\n;FindProxyForURL(${JSON.stringify(String(url))}, ${JSON.stringify(String(host))});`,
      sandbox, { timeout: PAC_EVAL_TIMEOUT_MS });
    if (typeof result !== 'string') return { error: `FindProxyForURL returned non-string '${typeof result}'`, alerts };
    return { result, alerts };
  } catch (e) {
    return { error: `PAC evaluation failed: ${e?.message ?? e}`, alerts };
  }
}

/**
 * Parse a PAC result string: "PROXY h:p; SOCKS h:p; DIRECT".
 * @returns {{kind:'proxy'|'direct'|'unsupported', url?:string}}
 */
export function parsePacResult(str) {
  for (const raw of String(str).split(';')) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^PROXY\s+([^\s]+)/i.exec(t);
    if (m) return { kind: 'proxy', url: `http://${m[1]}` };
    if (/^DIRECT\b/i.test(t)) return { kind: 'direct' };
    if (/^(SOCKS4?|SOCKS5?|HTTPS)\b/i.test(t)) return { kind: 'unsupported', scheme: t.split(/\s/)[0].toUpperCase() };
  }
  return { kind: 'unsupported', scheme: 'empty' };
}

/**
 * Fetch a PAC script — http(s) URL, file:// URL, or a plain filesystem path.
 * Bounded bytes + bounded time; failures return {error}.
 */
export async function fetchPacSource(pacUrl, { timeoutMs = PAC_FETCH_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const src = String(pacUrl ?? '').trim();
  if (!src) return { error: 'empty pacUrl' };
  try {
    if (/^https?:\/\//i.test(src)) {
      const u = new URL(src);
      if (!['http:', 'https:'].includes(u.protocol)) return { error: `pac scheme '${u.protocol}' unsupported` };
      const res = await fetchImpl(src, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      if (!res.ok) return { error: `PAC fetch HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > PAC_MAX_BYTES) return { error: `PAC script exceeds ${PAC_MAX_BYTES} bytes` };
      return { source: buf.toString('utf-8') };
    }
    const path = src.startsWith('file://') ? new URL(src) : src;
    const buf = readFileSync(path instanceof URL ? path : path);
    if (buf.length > PAC_MAX_BYTES) return { error: `PAC script exceeds ${PAC_MAX_BYTES} bytes` };
    return { source: buf.toString('utf-8') };
  } catch (e) {
    return { error: `PAC fetch failed: ${e?.message ?? e}` };
  }
}

/**
 * Full PAC resolution: fetch → per-probe-host evaluation → map onto the
 * single-proxy env surface.
 * @param {object} o {pacUrl, hosts:[probe hostnames], fetchImpl?}
 * @returns {object} {ok, proxy?, noProxy?, conflict?, error?, decisions?}
 */
export async function resolvePacProxy({ pacUrl, hosts = [], fetchImpl } = {}) {
  const probes = [...new Set(hosts.map((h) => String(h).toLowerCase().trim()).filter(Boolean))];
  if (!probes.length) return { error: 'pac mode requires at least one probe host (proxy.json hosts[])' };
  const f = await fetchPacSource(pacUrl, { fetchImpl });
  if (f.error) return { error: f.error };
  // Pre-resolve the probe names — sync DNS does not exist; PAC dnsResolve
  // answers ONLY these names (documented boundary). Bounded resolver: an
  // unreachable DNS server must not stall bootstrap on NXDOMAIN-less hangs.
  const resolveMap = {};
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  try {
    await Promise.all(probes.map(async (h) => {
      try { resolveMap[h] = (await resolver.resolve4(h))[0] ?? null; } catch { resolveMap[h] = null; }
    }));
  } finally {
    resolver.cancel();
  }
  const decisions = [];
  for (const h of probes) {
    const ev = evaluatePac(f.source, `https://${h}/`, h, { resolveMap });
    if (ev.error) return { error: ev.error, decisions };
    const p = parsePacResult(ev.result);
    decisions.push({ host: h, result: ev.result, kind: p.kind, url: p.url ?? null });
  }
  const proxies = decisions.filter((d) => d.kind === 'proxy');
  const unsupported = decisions.filter((d) => d.kind === 'unsupported');
  if (unsupported.length) {
    return { error: `PAC returned unsupported scheme for ${unsupported.map((d) => d.host).join(', ')} — SOCKS/HTTPS proxies are not expressible on the env-proxy surface`, decisions };
  }
  if (!proxies.length) return { ok: true, proxy: null, noProxy: [], decisions };
  const uniq = [...new Set(proxies.map((d) => d.url))];
  if (uniq.length > 1) {
    return { error: `PAC returns different proxies per host (${uniq.join(' vs ')}) — the env-proxy surface cannot express per-host proxies; refusing to flatten`, decisions, conflict: true };
  }
  return { ok: true, proxy: uniq[0], noProxy: decisions.filter((d) => d.kind === 'direct').map((d) => d.host), decisions };
}

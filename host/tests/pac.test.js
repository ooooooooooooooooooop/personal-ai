/**
 * dedup-h #727 — PAC/WPAD proxy discovery. The PAC script is remote code:
 * it runs sandboxed in node:vm with only the FindProxyForURL helper set,
 * bounded eval time, bounded fetch bytes. Resolution maps per-host verdicts
 * onto the single-proxy env surface — mixed proxies refuse, never flatten.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePac, parsePacResult, fetchPacSource, resolvePacProxy, PAC_MAX_BYTES } from '../src/core/pac.js';

const PAC = `
function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || dnsDomainIs(host, ".internal")) return "DIRECT";
  if (shExpMatch(host, "secure.*")) return "PROXY 10.0.0.9:8443; DIRECT";
  return "PROXY 10.0.0.1:8318; DIRECT";
}`;

test('evaluatePac: standard helpers drive per-host verdicts inside the sandbox', () => {
  const direct = evaluatePac(PAC, 'https://db.internal/', 'db.internal');
  assert.equal(direct.result, 'DIRECT');
  const plain = evaluatePac(PAC, 'http://printer/', 'printer');
  assert.equal(plain.result, 'DIRECT');
  const secure = evaluatePac(PAC, 'https://secure.corp/', 'secure.corp');
  assert.equal(secure.result, 'PROXY 10.0.0.9:8443; DIRECT');
  const pub = evaluatePac(PAC, 'https://api.anthropic.com/', 'api.anthropic.com');
  assert.equal(pub.result, 'PROXY 10.0.0.1:8318; DIRECT');
});

test('evaluatePac: sandbox boundary — no require/process; runaway script times out', () => {
  const esc = evaluatePac('function FindProxyForURL(u,h){ return typeof require !== "undefined" ? require("fs").readFileSync("/etc/passwd","utf8") : "DIRECT"; }',
    'https://x/', 'x');
  assert.equal(esc.result, 'DIRECT', 'require must not exist inside the vm');
  const loop = evaluatePac('function FindProxyForURL(u,h){ while(true){} }', 'https://x/', 'x');
  assert.match(loop.error, /failed|timed/i, 'infinite PAC loop bounded by eval timeout');
  const bad = evaluatePac('function FindProxyForURL(u,h){ return 42; }', 'https://x/', 'x');
  assert.match(bad.error, /non-string/);
  const empty = evaluatePac('', 'https://x/', 'x');
  assert.match(empty.error, /empty/);
});

test('evaluatePac: dnsResolve answers only pre-resolved names; alert is captured', () => {
  const pac = `function FindProxyForURL(url, host){
    alert("resolving " + host);
    if (isResolvable(host) && isInNet(host, "10.0.0.0", "255.0.0.0")) return "DIRECT";
    return "PROXY 10.0.0.1:8318";
  }`;
  const inside = evaluatePac(pac, 'https://inside.corp/', 'inside.corp', { resolveMap: { 'inside.corp': '10.2.3.4' } });
  assert.equal(inside.result, 'DIRECT');
  assert.deepEqual(inside.alerts, ['resolving inside.corp']);
  const outside = evaluatePac(pac, 'https://unknown.example/', 'unknown.example', { resolveMap: {} });
  assert.equal(outside.result, 'PROXY 10.0.0.1:8318', 'unresolvable name falls to isResolvable=false');
});

test('parsePacResult: first usable entry wins; SOCKS/HTTPS honestly unsupported', () => {
  assert.deepEqual(parsePacResult('PROXY 10.0.0.1:8318'), { kind: 'proxy', url: 'http://10.0.0.1:8318' });
  assert.deepEqual(parsePacResult('DIRECT'), { kind: 'direct' });
  assert.deepEqual(parsePacResult('SOCKS5 h:1; DIRECT'), { kind: 'unsupported', scheme: 'SOCKS5' });
  assert.deepEqual(parsePacResult('SOCKS h:1; PROXY p:2'), { kind: 'unsupported', scheme: 'SOCKS' },
    'SOCKS listed first is not skipped — it is the verdict, and unsupported must not silently downgrade to the next entry');
});

test('fetchPacSource: file path + file:// load; oversized refuses; http errors surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-pac-'));
  const file = join(dir, 'proxy.pac');
  writeFileSync(file, PAC);
  const a = await fetchPacSource(file);
  assert.ok(a.source.includes('FindProxyForURL'));
  const b = await fetchPacSource(`file://${file.replace(/\\/g, '/')}`);
  assert.ok(b.source.includes('FindProxyForURL'));
  writeFileSync(join(dir, 'big.pac'), 'x'.repeat(PAC_MAX_BYTES + 1));
  const big = await fetchPacSource(join(dir, 'big.pac'));
  assert.match(big.error, /exceeds/);
  const httpErr = await fetchPacSource('http://pac.local/wpad.dat', {
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.match(httpErr.error, /404/);
});

test('resolvePacProxy: unanimous PROXY applies + DIRECT hosts become noProxy; mixed proxies refuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-pacres-'));
  const file = join(dir, 'proxy.pac');
  writeFileSync(file, PAC);
  const r = await resolvePacProxy({ pacUrl: file, hosts: ['api.anthropic.com', 'db.internal'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.proxy, 'http://10.0.0.1:8318');
  assert.deepEqual(r.noProxy, ['db.internal']);

  const allDirect = await resolvePacProxy({ pacUrl: file, hosts: ['db.internal', 'printer.internal'] });
  assert.equal(allDirect.ok, true);
  assert.equal(allDirect.proxy, null, 'all-DIRECT verdicts apply no proxy');

  const mixed = `
function FindProxyForURL(url, host) {
  if (host === "a.example") return "PROXY 10.0.0.1:1";
  return "PROXY 10.0.0.2:2";
}`;
  writeFileSync(join(dir, 'mixed.pac'), mixed);
  const conflict = await resolvePacProxy({ pacUrl: join(dir, 'mixed.pac'), hosts: ['a.example', 'b.example'] });
  assert.ok(conflict.error && conflict.conflict, 'per-host proxy divergence must refuse, not flatten');

  const noHosts = await resolvePacProxy({ pacUrl: file, hosts: [] });
  assert.match(noHosts.error, /probe host/);

  const missing = await resolvePacProxy({ pacUrl: join(dir, 'nope.pac'), hosts: ['x.example'] });
  assert.match(missing.error, /fetch failed|ENOENT/i);
});

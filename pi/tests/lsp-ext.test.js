/**
 * LSP managed extension — Content-Length framing, handshake, read-only
 * tools (definition/references/hover/symbols/diagnostics), config mapping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lspExtension, { LspClient } from '../extensions/lsp/index.js';
import { pathToFileURL } from 'node:url';

const FAKE_LSP_JS = `
let buf = Buffer.alloc(0);
const send = (msg) => {
  const b = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(b) + '\\r\\n\\r\\n' + b);
};
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const he = buf.indexOf('\\r\\n\\r\\n');
    if (he < 0) return;
    const m = /content-length:\\s*(\\d+)/i.exec(buf.slice(0, he).toString());
    const len = Number(m[1]);
    if (buf.length < he + 4 + len) return;
    const msg = JSON.parse(buf.slice(he + 4, he + 4 + len).toString());
    buf = buf.slice(he + 4 + len);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true } } });
    } else if (msg.method === 'textDocument/didOpen') {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: msg.params.textDocument.uri, diagnostics: [{ severity: 2, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, source: 'fake', message: 'unused variable' }] } });
    } else if (msg.method === 'textDocument/definition') {
      send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: msg.params.textDocument.uri, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } } }] });
    } else if (msg.method === 'textDocument/hover') {
      send({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'plaintext', value: 'const foo: number' } } });
    } else if (msg.method === 'textDocument/documentSymbol') {
      send({ jsonrpc: '2.0', id: msg.id, result: [{ name: 'main', kind: 12, range: { start: { line: 0 } }, selectionRange: { start: { line: 0 } }, children: [{ name: 'helper', kind: 12, selectionRange: { start: { line: 3 } } }] }] });
    } else if (msg.method === 'textDocument/references') {
      send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: 'file:///proj/a.ts', range: { start: { line: 9, character: 0 } } }] });
    } else if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
      process.exit(0);
    } else if (msg.id != null) {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  }
});
setInterval(() => {}, 1000);
`;

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  const commands = new Map();
  return {
    tools, handlers, commands,
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (n, o) => commands.set(n, o),
    on: (e, h) => handlers.set(e, h),
  };
}

async function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'pai-lsp-'));
  const serverPath = join(dir, 'lsp.js');
  writeFileSync(serverPath, FAKE_LSP_JS);
  const srcFile = join(dir, 'a.ts');
  writeFileSync(srcFile, 'const foo = 1;\nfunction main() { return foo; }\n');
  const cfgPath = join(dir, 'lsp.json');
  writeFileSync(cfgPath, JSON.stringify({
    servers: { ts: { command: process.execPath, args: [serverPath], extensions: ['.ts'], rootPatterns: ['lsp.json'] } },
  }));
  return { dir, serverPath, srcFile, cfgPath };
}

test('lsp client: Content-Length handshake + definition + hover + diagnostics', async () => {
  const { dir, serverPath, srcFile } = await makeEnv();
  try {
    const client = await LspClient.start(
      { command: process.execPath, args: [serverPath] },
      { rootUri: pathToFileURL(dir).href },
    );
    try {
      const uri = await client.ensureOpen(srcFile, 'typescript');
      const def = await client.request('textDocument/definition', {
        textDocument: { uri }, position: { line: 1, character: 25 },
      });
      assert.equal(def[0].range.start.line, 4);
      const hover = await client.request('textDocument/hover', {
        textDocument: { uri }, position: { line: 0, character: 6 },
      });
      assert.equal(hover.contents.value, 'const foo: number');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(client.diagnosticsFor(srcFile)[0].message, 'unused variable');
    } finally {
      client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lsp extension: registers read-only tools, formats results, no config → no tools fired', async () => {
  const { dir, srcFile, cfgPath } = await makeEnv();
  const prev = process.env.PAI_LSP_CONFIG;
  process.env.PAI_LSP_CONFIG = cfgPath;
  try {
    const pi = fakePi();
    lspExtension(pi);
    assert.ok(pi.tools.has('lsp_definition'));
    assert.ok(pi.tools.has('lsp_references'));
    assert.ok(pi.tools.has('lsp_hover'));
    assert.ok(pi.tools.has('lsp_symbols'));
    assert.ok(pi.tools.has('lsp_diagnostics'));
    // read-only by construction: no rename/applyEdit/codeAction tools exist
    for (const name of pi.tools.keys()) assert.match(name, /^lsp_(definition|references|hover|symbols|diagnostics)$/);

    const def = await pi.tools.get('lsp_definition').execute('t1', { file: srcFile, line: 2, character: 26 });
    assert.match(def.content[0].text, /a\.ts:5:3/);
    const sym = await pi.tools.get('lsp_symbols').execute('t2', { file: srcFile });
    assert.match(sym.content[0].text, /main.*:1/);
    assert.match(sym.content[0].text, /helper.*:4/);
    await pi.handlers.get('session_shutdown')?.();
  } finally {
    if (prev === undefined) delete process.env.PAI_LSP_CONFIG;
    else process.env.PAI_LSP_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lsp extension: unknown extension fails closed with a clear error', async () => {
  const { dir, cfgPath } = await makeEnv();
  const prev = process.env.PAI_LSP_CONFIG;
  process.env.PAI_LSP_CONFIG = cfgPath;
  try {
    const pyFile = join(dir, 'x.py');
    writeFileSync(pyFile, 'print(1)\n');
    const pi = fakePi();
    lspExtension(pi);
    const res = await pi.tools.get('lsp_definition').execute('t1', { file: pyFile, line: 1, character: 1 });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no LSP server configured for '\.py'/);
    await pi.handlers.get('session_shutdown')?.();
  } finally {
    if (prev === undefined) delete process.env.PAI_LSP_CONFIG;
    else process.env.PAI_LSP_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

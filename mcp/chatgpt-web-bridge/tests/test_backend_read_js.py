"""Behavior tests for BackendClient._read_js' page-side fetch boundary.

The wrapper is captured from the real Python helper and executed by Node with
fake fetch/AbortController behavior. No browser, account, or network request
is used by this test.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from unittest.mock import AsyncMock, MagicMock

import pytest

from chatgpt_web2api.backend_client import BackendClient


NODE = shutil.which("node")


async def _capture_wrapper(expr: str) -> str:
    driver = MagicMock()
    driver._js_with_data_strict = AsyncMock(return_value="__captured_success__")
    client = BackendClient(driver)
    await client._read_js(expr, {}, timeout=0.5)
    return driver._js_with_data_strict.await_args.args[0]


def _run_node(wrapper: str, mode: str) -> dict:
    script = r"""
let calls = 0;
let aborted = false;
let bodyAborted = false;
const mode = __MODE__;
const abortError = () => {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
};
const headers = {
  get: (name) => name.toLowerCase() === 'retry-after' && mode === 'http429' ? '17' : null,
};
globalThis.fetch = async (_url, init = {}) => {
  calls += 1;
  const signal = init.signal;
  if (mode === 'network') throw new TypeError('offline');
  if (mode === 'security') {
    const e = new Error('Not allowed by permissions policy');
    e.name = 'SecurityError';
    throw e;
  }
  if (mode === 'never') {
    return await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(abortError());
      }, {once: true});
    });
  }
  if (mode === 'body') {
    return {
      ok: true, status: 200, headers,
      text: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          bodyAborted = true;
          reject(abortError());
        }, {once: true});
      }),
    };
  }
  if (mode.startsWith('http')) {
    const status = Number(mode.slice(4));
    return {ok: false, status, headers};
  }
  return {
    ok: true, status: 200, headers,
    json: async () => ({items: []}),
    text: async () => 'ok',
  };
};
(async () => {
  let result;
  try {
    const value = await eval(__WRAPPER__);
    result = {ok: true, value};
  } catch (e) {
    result = {ok: false, thrown: {name: e.name, message: String(e.message || e)}};
  }
  result.calls = calls;
  result.aborted = aborted;
  result.bodyAborted = bodyAborted;
  process.stdout.write(JSON.stringify(result));
})().catch((e) => {
  process.stdout.write(JSON.stringify({ok: false, harness_error: String(e)}));
  process.exitCode = 1;
});
"""
    script = script.replace("__MODE__", json.dumps(mode), 1)
    script = script.replace("__WRAPPER__", json.dumps(wrapper), 1)
    completed = subprocess.run(
        [NODE, "-e", script],
        capture_output=True,
        text=True,
        timeout=3,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout
    return json.loads(completed.stdout)


@pytest.mark.skipif(NODE is None, reason="Node.js is required for wrapper behavior tests")
@pytest.mark.parametrize(
    ("mode", "expected_status"),
    [
        ("http401", 401),
        ("http403", 403),
        ("http429", 429),
        ("http500", 500),
    ],
)
def test_read_wrapper_tags_http_status_without_retry(mode: str, expected_status: int):
    wrapper = asyncio.run(
        _capture_wrapper("(async () => { const r = await fetch('/read'); return JSON.stringify(await r.json()); })()")
    )
    result = _run_node(wrapper, mode)
    assert result["ok"] is True
    error = json.loads(result["value"])["__cgw_read_error__"]
    assert error["kind"] == "http"
    assert error["status"] == expected_status
    if expected_status == 429:
        assert error["retry_after"] == "17"
    assert result["calls"] == 1


@pytest.mark.skipif(NODE is None, reason="Node.js is required for wrapper behavior tests")
def test_read_wrapper_success_and_network_failure_are_distinct():
    expr = "(async () => { const r = await fetch('/read'); return JSON.stringify(await r.json()); })()"
    wrapper = asyncio.run(_capture_wrapper(expr))

    success = _run_node(wrapper, "success")
    assert success["ok"] is True
    assert success["value"] == '{"items":[]}'
    assert success["calls"] == 1

    network = _run_node(wrapper, "network")
    assert network["ok"] is True
    network_error = json.loads(network["value"])["__cgw_read_error__"]
    assert network_error["kind"] == "network"
    assert network["calls"] == 1


@pytest.mark.skipif(NODE is None, reason="Node.js is required for wrapper behavior tests")
def test_read_wrapper_permission_is_rethrown_without_retry():
    wrapper = asyncio.run(
        _capture_wrapper("(async () => { const r = await fetch('/read'); return await r.text(); })()")
    )
    result = _run_node(wrapper, "security")
    assert result["ok"] is False
    assert result["thrown"]["name"] == "SecurityError"
    assert result["calls"] == 1


@pytest.mark.skipif(NODE is None, reason="Node.js is required for wrapper behavior tests")
@pytest.mark.parametrize("mode", ["never", "body"])
def test_read_wrapper_aborts_stalled_fetch_and_body(mode: str):
    if mode == "body":
        expr = "(async () => { const r = await fetch('/read'); return await r.text(); })()"
    else:
        expr = "(async () => { await fetch('/read'); return 'unreachable'; })()"
    wrapper = asyncio.run(_capture_wrapper(expr))
    result = _run_node(wrapper, mode)
    assert result["ok"] is True
    error = json.loads(result["value"])["__cgw_read_error__"]
    assert error["kind"] == "timeout"
    assert result["calls"] == 1
    if mode == "never":
        assert result["aborted"] is True
    else:
        assert result["bodyAborted"] is True


@pytest.mark.skipif(NODE is None, reason="Node.js is required for wrapper behavior tests")
def test_read_wrapper_rejects_non_get_before_native_fetch():
    wrapper = asyncio.run(
        _capture_wrapper("(async () => { await fetch('/read', {method: 'POST'}); return 'bad'; })()")
    )
    result = _run_node(wrapper, "success")
    assert result["ok"] is True
    error = json.loads(result["value"])["__cgw_read_error__"]
    assert error["kind"] == "protocol"
    assert "read boundary only permits GET" in error["message"]
    assert result["calls"] == 0

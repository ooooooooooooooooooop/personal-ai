"""Physical launcher lifecycle using an isolated fixture distribution.

Runs the production PowerShell launcher, its preflight exit-code boundary and
an actual Node HTTP listener. Full compatibility-engine tests live in
 test_preflight_deployment; no live DSH config, account or port is required.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "dsh-config/profiles/web/dsh-launch-web.ps1"


def get_free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(os.name == "nt", "PowerShell Windows launcher")
class ColdRestartSurvivalTests(unittest.TestCase):
    def setUp(self):
        self.shell = shutil.which("pwsh") or shutil.which("powershell")
        self.node = None
        for candidate in (shutil.which("node"), Path.home() / ".dsh/runtime/node-v22.19.0-win-x64/node.exe"):
            if not candidate or not Path(candidate).is_file():
                continue
            version = subprocess.check_output([str(candidate), "--version"], text=True).strip()
            if re.match(r"^v(22\.(?:19|2[0-9])|(?:2[4-9]|[3-9][0-9])\.)", version):
                self.node = str(candidate)
                break
        if not self.shell or not self.node:
            self.skipTest("requires PowerShell and a supported Node runtime")
        self.temp = tempfile.TemporaryDirectory(prefix="dsh-cold-restart-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.profile = self.root / "profiles/web"
        package = self.profile / "base-dsh-fixture/node_modules/@deepseek-ai/dsh"
        package.mkdir(parents=True)
        (package / "package.json").write_text(json.dumps({"name": "@deepseek-ai/dsh", "version": "fixture"}), encoding="utf8")
        self.entry = package / "bin.cjs"
        self.entry.write_text(r"""
const http = require('node:http');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
if (!args.includes('web') || !args.includes('--no-open') || !port) process.exit(2);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({fixture: 'cold-start', home: process.env.DSH_HOME}));
  if (req.url === '/shutdown') server.close(() => process.exit(0));
});
server.listen(port, '127.0.0.1');
""", encoding="utf8")
        (self.profile / "dsh-managed-state.json").write_text(json.dumps({"current": {
            "nodeRelativePath": "runtime/fixture", "version": "fixture",
            "entryRelative": self.entry.relative_to(self.root).as_posix(),
        }}), encoding="utf8")
        self.gate = self.profile / "dsh-preflight.py"
        self.gate.write_text("import json\nprint(json.dumps({'passed': True}))\n", encoding="utf8")
        self.port = get_free_port()
        self.process = None
        self.log = self.root / "launcher.log"
        self.addCleanup(self.stop_child)

    def start(self):
        env = dict(os.environ)
        env["DSH_HOME"] = str(self.root / "wrong-home")
        with self.log.open("w", encoding="utf8") as stream:
            self.process = subprocess.Popen([
                self.shell, "-NoProfile", "-File", str(LAUNCHER),
                "-ProfileRoot", str(self.profile), "-NodePath", self.node,
                "-Port", str(self.port),
            ], stdout=stream, stderr=subprocess.STDOUT, env=env,
                creationflags=subprocess.CREATE_NO_WINDOW)

    def stop_child(self):
        if self.process and self.process.poll() is None:
            # Only this test's Popen-owned process tree is eligible for cleanup.
            subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            self.process.wait(timeout=10)

    def request(self, path="/"):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{self.port}{path}", timeout=1) as response:
            return json.load(response)

    def test_cold_start_lifecycle_and_shutdown(self):
        self.start()
        deadline = time.monotonic() + 20
        payload = None
        while time.monotonic() < deadline and self.process.poll() is None:
            try:
                payload = self.request()
                break
            except (OSError, urllib.error.URLError):
                time.sleep(0.05)
        self.assertIsNotNone(payload, self.log.read_text(encoding="utf8", errors="replace"))
        self.assertEqual(payload["fixture"], "cold-start")
        self.assertEqual(Path(payload["home"]).resolve(), self.root.resolve())
        self.request("/shutdown")
        self.assertEqual(self.process.wait(timeout=10), 0)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", self.port))

    def test_occupied_configured_port_blocks_second_instance(self):
        with socket.socket() as guard:
            guard.bind(("127.0.0.1", self.port))
            guard.listen(1)
            self.start()
            self.assertNotEqual(self.process.wait(timeout=20), 0)
            self.assertIn("SINGLE_INSTANCE_GUARD", self.log.read_text(encoding="utf8", errors="replace"))

    def test_failed_preflight_never_starts_listener(self):
        self.gate.write_text("raise SystemExit(7)\n", encoding="utf8")
        self.start()
        self.assertNotEqual(self.process.wait(timeout=20), 0)
        self.assertIn("PREFLIGHT_GATE_REJECT", self.log.read_text(encoding="utf8", errors="replace"))
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", self.port))


if __name__ == "__main__":
    unittest.main()

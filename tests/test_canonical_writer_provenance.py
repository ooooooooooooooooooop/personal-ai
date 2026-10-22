"""Regression tests for canonical writer provenance and commit audit."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "governance"))

import personal_ai_sync as pas  # noqa: E402
import canonical_writer as cw  # noqa: E402


def git(repo: Path, *args: str, check: bool = True, author: str = "ownership-test") -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": author,
        "GIT_AUTHOR_EMAIL": f"{author}@invalid",
        "GIT_COMMITTER_NAME": author,
        "GIT_COMMITTER_EMAIL": f"{author}@invalid",
    }
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    if check and result.returncode != 0:
        raise AssertionError(f"git {args} failed: {result.stdout}\n{result.stderr}")
    return (result.stdout + result.stderr).strip()


def init_repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-b", "main", str(path)], capture_output=True, check=True)
    git(path, "config", "user.name", "ownership-test")
    git(path, "config", "user.email", "ownership-test@invalid")
    (path / "seed.txt").write_text("seed\n", encoding="utf-8")
    git(path, "add", "seed.txt")
    git(path, "commit", "-m", "initial")
    return path


class TestCanonicalWriterProvenance(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="writer-provenance-")
        self.root = Path(self.temp.name).resolve()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_a_governed_commit_contains_complete_provenance_and_audits_clean(self) -> None:
        repo = init_repo(self.root / "repo")
        locks = self.root / "locks"
        audit_root = self.root / "audit"
        (repo / "owned.txt").write_text("owned\n", encoding="utf-8")

        ok, message = pas.commit_owned_files(
            repo,
            ["owned.txt"],
            actor="test-writer",
            actor_type="automated",
            trigger="test-a",
            task_id="task-a",
            thread_id="thread-a",
            entrypoint="test-entrypoint",
            process_start_time="2026-09-03T00:00:00+00:00",
            run_id="run-a",
            validate=False,
            lock_root=locks,
            canonical_root=repo,
        )
        self.assertTrue(ok, message)
        receipt_path = next((locks / "receipts").glob("*.json"))
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        self.assertTrue(all(field in receipt for field in pas.PROVENANCE_REQUIRED_FIELDS))
        self.assertEqual(receipt["actor"], "test-writer")
        self.assertEqual(receipt["actor_type"], "automated")
        self.assertEqual(receipt["task_id"], "task-a")
        self.assertEqual(receipt["run_id"], "run-a")
        self.assertEqual(receipt["thread_id"], "thread-a")
        self.assertEqual(receipt["entrypoint"], "test-entrypoint")
        self.assertEqual(receipt["owned_scope"], ["owned.txt"])
        self.assertEqual(receipt["changed_files"], ["owned.txt"])
        self.assertTrue(pas.validate_mutation_receipt(receipt_path, repo, commit=receipt["commit"]))

        audit = pas.audit_canonical_commits(
            repo,
            audit_root=audit_root,
            receipt_root=locks / "receipts",
            previous_head=receipt["base_head"],
            persist=False,
        )
        self.assertEqual(audit["status"], "CLEAN")
        self.assertEqual(audit["unauthorized"], [])

    def test_b_raw_commit_is_detected_without_head_repair(self) -> None:
        repo = init_repo(self.root / "repo")
        audit_root = self.root / "audit"
        initial = git(repo, "rev-parse", "HEAD")
        baseline = pas.audit_canonical_commits(repo, audit_root=audit_root)
        self.assertEqual(baseline["status"], "BASELINE_INITIALIZED")

        (repo / "raw.txt").write_text("raw\n", encoding="utf-8")
        git(repo, "add", "raw.txt")
        git(repo, "commit", "-m", "raw writer")
        after = git(repo, "rev-parse", "HEAD")
        audit = pas.audit_canonical_commits(repo, audit_root=audit_root)

        self.assertEqual(audit["status"], pas.UNAUTHORIZED_OR_UNATTRIBUTED_CANONICAL_MUTATION)
        self.assertEqual(audit["result"], "REVIEW")
        self.assertEqual(audit["previous_audited_head"], initial)
        self.assertEqual(audit["current_head"], after)
        self.assertEqual(audit["unauthorized"][0]["commit"], after)
        self.assertEqual(audit["unauthorized"][0]["affected_files"], ["raw.txt"])
        self.assertEqual(git(repo, "rev-parse", "HEAD"), after)

    def test_c_governed_push_writes_remote_integrity_fields(self) -> None:
        repo = init_repo(self.root / "repo")
        remote = self.root / "remote.git"
        subprocess.run(["git", "init", "--bare", str(remote)], capture_output=True, check=True)
        git(repo, "remote", "add", "origin", str(remote))
        git(repo, "push", "-u", "origin", "main")

        mutation_root = repo.parent / f".{repo.name}.personal-ai-mutation"
        (repo / "owned.txt").write_text("owned\n", encoding="utf-8")
        ok, message = pas.commit_owned_files(
            repo,
            ["owned.txt"],
            actor="test-writer",
            actor_type="automated",
            trigger="test-c",
            task_id="task-c",
            validate=False,
            lock_root=mutation_root,
            canonical_root=repo,
        )
        self.assertTrue(ok, message)

        plan = [{"plane": "personal-ai", "action": "PUSH", "state": pas.LOCAL_AHEAD}]
        classification = {
            "path": str(repo),
            "branch": "main",
            "graph_state": pas.LOCAL_AHEAD,
            "state": pas.LOCAL_AHEAD,
            "worktree_state": pas.WORKTREE_CLEAN,
            "dirty": False,
        }
        pas.execute_plan(plan, {"personal-ai": classification}, None, "push", {
            "actor": "test-writer",
            "actor_type": "automated",
            "trigger": "test-c",
            "task_id": "task-c",
            "run_id": "run-c",
            "thread_id": "thread-c",
        })

        self.assertTrue(plan[0].get("executed"), plan[0])
        push_receipts = [
            json.loads(path.read_text(encoding="utf-8"))
            for path in (mutation_root / "receipts").glob("*.json")
            if json.loads(path.read_text(encoding="utf-8")).get("result") == "PUSHED"
        ]
        self.assertEqual(len(push_receipts), 1)
        receipt = push_receipts[0]
        self.assertNotEqual(receipt["remote_before"], pas.PROVENANCE_UNKNOWN)
        self.assertNotEqual(receipt["remote_after"], pas.PROVENANCE_UNKNOWN)
        self.assertEqual(receipt["push_target"], "origin/main")
        self.assertTrue(pas.validate_mutation_receipt(
            mutation_root / "receipts" / next(
                path.name for path in (mutation_root / "receipts").glob("*.json")
                if json.loads(path.read_text(encoding="utf-8")).get("result") == "PUSHED"
            ),
            repo,
            commit=receipt["commit"],
            operation="explicit-push",
        ))

    def test_d_foreign_commit_is_reviewed_and_not_reverted(self) -> None:
        repo = init_repo(self.root / "repo")
        audit_root = self.root / "audit"
        pas.audit_canonical_commits(repo, audit_root=audit_root)
        (repo / "foreign.txt").write_text("foreign\n", encoding="utf-8")
        git(repo, "add", "foreign.txt", author="foreign-writer")
        git(repo, "commit", "-m", "foreign commit", author="foreign-writer")
        before_audit = git(repo, "rev-parse", "HEAD")

        audit = pas.audit_canonical_commits(repo, audit_root=audit_root)

        self.assertEqual(audit["result"], "REVIEW")
        self.assertEqual(audit["unauthorized"][0]["author"]["name"], "foreign-writer")
        self.assertEqual(git(repo, "rev-parse", "HEAD"), before_audit)

    def test_e_no_change_does_not_raise_false_alert(self) -> None:
        repo = init_repo(self.root / "repo")
        audit_root = self.root / "audit"
        pas.audit_canonical_commits(repo, audit_root=audit_root)

        audit = pas.audit_canonical_commits(repo, audit_root=audit_root)

        self.assertEqual(audit["status"], "NO_CHANGE")
        self.assertEqual(audit["result"], "PASS")
        self.assertEqual(audit["unauthorized"], [])


class TestPostCommitGovernedScope(unittest.TestCase):
    """post-commit 的作用域判据必须与 pre-commit / push 一致：只对受治理切片负责。

    回归背景（2026-10-22）：``cmd_post_commit`` 曾用「整提交 changed ⊆ lock.scope」
    判外族。于是一次「受治理内容 + 大量非受治理删除」的提交在 pre-commit 合法通过，
    在这里被判越权，COMMITTED 回执写不出来；而 git 忽略 post-commit 的退出码，
    这次拒绝不阻断提交，只在稍后的 push_governed_ref 处才以
    PUSH_REF_MISSING_COMMIT_RECEIPT 暴露。这两条用例锁住「受治理判定」与
    「越权仍然拒绝」两面。
    """

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="post-commit-scope-")
        self.root = Path(self.temp.name).resolve()
        self.repo = init_repo(self.root / "repo")
        self.locks = self.root / "locks"
        self._saved_env = {key: os.environ.get(key) for key in cw.WRITER_REQUIRED_ENV}

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.temp.cleanup()

    def _events(self) -> list[dict]:
        return [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted((self.locks / "events").glob("*.json"))
        ]

    def _post_commit(self, scope: list[str], writes: dict[str, str]) -> int:
        """在活跃租约内提交 ``writes``，然后按 hook 的方式调用 post-commit。"""
        lock = pas.CanonicalMutationLock(
            self.repo,
            actor="post-commit-test",
            actor_type="automated",
            harness="test-harness",
            trigger="test-post-commit",
            task_id="task-post-commit",
            thread_id="thread-post-commit",
            session_id="session-post-commit",
            cwd=str(self.repo),
            entrypoint="tests/test_canonical_writer_provenance.py",
            operation="content-mutation",
            scope=list(scope),
            run_id="run-post-commit",
            mutation_lease_id="lease-post-commit",
            lock_root=self.locks,
            canonical_root=self.repo,
        )
        with lock:
            pas.write_mutation_event(
                self.repo,
                "COMMIT_INTENT",
                {
                    "run_id": lock.run_id,
                    "mutation_lease_id": lock.mutation_lease_id,
                    "base_head": git(self.repo, "rev-parse", "HEAD"),
                    "owned_paths": list(lock.scope),
                    "staged_paths": sorted(writes),
                },
                lock_root=lock.lock_root,
            )
            for rel, body in writes.items():
                target = self.repo / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(body, encoding="utf-8")
            git(self.repo, "add", "-A")
            git(self.repo, "commit", "-m", "scoped change")
            os.environ[cw.WRITER_REQUIRED_ENV[0]] = lock.mutation_lease_id
            os.environ[cw.WRITER_REQUIRED_ENV[1]] = lock.run_id
            return cw.cmd_post_commit(
                argparse.Namespace(
                    repo=str(self.repo),
                    lock_root=str(self.locks),
                    harness="test-harness",
                    lease_id=None,
                    run_id=None,
                )
            )

    def test_mixed_commit_records_receipt_for_governed_slice_only(self) -> None:
        exit_code = self._post_commit(
            ["mind/state.md"],
            {"mind/state.md": "v1\n", "docs/note.md": "note\n"},
        )
        self.assertEqual(exit_code, 0)

        receipts = sorted((self.locks / "receipts").glob("*.json"))
        self.assertEqual(len(receipts), 1)
        receipt = json.loads(receipts[0].read_text(encoding="utf-8"))
        self.assertEqual(receipt["result"], "COMMITTED")
        # 回执只声明租约拥有的资产，否则 _receipt_scope_is_valid 会判它超权
        self.assertEqual(receipt["changed_files"], ["mind/state.md"])
        self.assertEqual(receipt["owned_scope"], ["mind/state.md"])
        head = git(self.repo, "rev-parse", "HEAD")
        self.assertTrue(pas._owned_commit_receipt(self.repo, head, self.locks / "receipts"))

        # 但整份改动必须留在证据链里：回执只记一部分而不留全貌，就是另一种静默删除
        notes = [e for e in self._events() if e.get("event_type") == "COMMIT_NON_GOVERNED_CHANGES"]
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["governed_changed"], ["mind/state.md"])
        self.assertEqual(notes[0]["non_governed_changed"], ["docs/note.md"])
        self.assertEqual(notes[0]["result_head"], head)

    def test_governed_write_outside_scope_still_aborts(self) -> None:
        exit_code = self._post_commit(["mind/state.md"], {"mind/other.md": "stray\n"})
        self.assertEqual(exit_code, 2)
        self.assertEqual(sorted((self.locks / "receipts").glob("*.json")), [])

        violations = [e for e in self._events() if e.get("event_type") == "SCOPE_VIOLATION"]
        self.assertEqual(len(violations), 1)
        self.assertEqual(violations[0]["foreign_paths"], ["mind/other.md"])
        self.assertEqual(violations[0]["governed_changed"], ["mind/other.md"])


if __name__ == "__main__":
    unittest.main()

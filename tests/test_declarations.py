"""test_declarations.py — 声明即须可核（declared ⇒ checkable）。

本模块来自 2026-09-24 一整轮"声明 vs 实况"的复盘：同一天里，世界模型/DSH/soul
三条线上抓到的缺陷**全都是同一形状** —— 某处写下一个断言，而**没有任何门禁会去核它**：

* `WORLD_MODEL_HOME` 语义在文档与代码里各是一个（→ 起不来）
* 指令槽把 target 当 cap（→ 真实试点源被截断、丢操作化步骤）
* schema 1.2 声明了必填 `provenance`，实例 11 条记录没有（→ 13 项校验失败，无校验器）
* `AGENTS.md` 写死"20 个 skills / 8 个工具"，实况 22 / 11
* `soul` 发布摘要与内容不符，而它的 `verifier` 只在回归里被动跑着（→ 回归本就红）

**共同点**：断言写下了，但"谁来核"没有写下。本模块把 `soul/manifest.json` 里
**可机检的声明**逐条钉住 —— 它不重复既有覆盖（`validate_repo` 管两个注册表/链接/
运行态边界；`test_repository` 管 release 锚与许可证；`test_wm_v031` 管编译器容量常量）。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOUL = ROOT / "soul"
MANIFEST = json.loads((SOUL / "manifest.json").read_text(encoding="utf-8"))


class TestSoulManifestDeclaredPathsExist(unittest.TestCase):
    """manifest 指到哪儿，哪儿就得真有东西。

    改名正是它漂移的经典路径：`soul/policy/template.md` 变成
    `soul/instruction/template.md`，manifest 得靠人手跟着改。
    **此前没有任何东西会核它** —— 漏改就静默 dangling。

    路径基数分两种：`compiler` / `verifier` 相对**仓根**，其余相对 `soul/`。
    """

    def test_compilers_and_verifier_exist(self):
        for label, rel in [
            ("briefing.compiler", MANIFEST["briefing"]["compiler"]),
            ("instruction.compiler", MANIFEST["instruction"]["compiler"]),
            ("release.verifier", MANIFEST["release"]["verifier"]),
        ]:
            with self.subTest(label=label):
                self.assertTrue((ROOT / rel).is_file(),
                                f"{label} 指向不存在的文件: {rel}")

    def test_templates_models_and_bootstrap_exist(self):
        cases = [
            ("briefing.template", MANIFEST["briefing"]["template"]),
            ("instruction.template", MANIFEST["instruction"]["template"]),
            ("bootstrap.canonical", MANIFEST["bootstrap"]["canonical"]),
            ("bootstrap.seeds", MANIFEST["bootstrap"]["seeds"]),
        ]
        for group in ("l2", "l3"):
            for rec in MANIFEST["models"].get(group, []):
                cases.append((f"models.{group}[{rec['model_id']}].file", rec["file"]))
        for label, rel in cases:
            with self.subTest(label=label):
                self.assertTrue((SOUL / rel).exists(),
                                f"{label} 指向不存在的路径: soul/{rel}")

    def test_no_policy_leftovers_after_the_instruction_rename(self):
        """`policy` → `instruction` 改名后，不该再有并存的旧名。

        两个名字并存会让"同一域两个名字"，比不改更乱（C3 的处置结论）。
        """
        self.assertFalse((SOUL / "policy").exists(),
                         "soul/policy 应为空：改名后不应并存旧目录")


class TestSchemaVersionIsTied(unittest.TestCase):
    """manifest 声明的 schema 版本 = 发布出去的 schema 文件里 const 的那个。

    两者都是发布锚，**此前没有任何东西把二者绑在一起** ——
    只改一个就会让"声明支持的 schema"与"实际发布的 schema"静默分叉（G12 的一半）。
    """

    def test_manifest_schema_version_matches_published_schema_const(self):
        published = json.loads(
            (SOUL / "schema" / "canonical.schema.json").read_text(encoding="utf-8"))
        const = published["properties"]["schema_version"]["const"]
        self.assertEqual(
            MANIFEST["schema_version"], const,
            "soul/manifest.json 的 schema_version 与 soul/schema/canonical.schema.json "
            f"的 const 不一致：{MANIFEST['schema_version']!r} vs {const!r}")

    def test_manifest_tags_are_consistent(self):
        self.assertEqual(MANIFEST["release"]["tag"],
                         f"soul-{MANIFEST['soul_version']}",
                         "release.tag 必须等于 soul-<soul_version>")


@unittest.skipUnless(shutil.which("node"), "node runtime not found")
class TestDeclaredMountIsReal(unittest.TestCase):
    """`instruction.mounts_as` 是一条**关于代码的断言**，所以就去问代码。

    manifest 写 `mounts_as: "InstructionEnvelope.instructions"`；此前没有任何检查
    证明那份产物**真的**落在这个字段上。这里直接 import 信封构造器问它。
    """

    def test_instruction_envelope_really_carries_the_policy_text(self):
        script = (
            "const m = await import('file:///" + str(ROOT / "host/src/core/envelopes.js")
            .replace("\\", "/") + "');\n"
            "const env = m.buildInstructionEnvelope({ soulManifest: {}, policyText: 'PROBE_42', "
            "policyChecksum: 'x', provenance: {} });\n"
            "if (env.kind !== 'InstructionEnvelope') { console.log('BAD_KIND:' + env.kind); }\n"
            "else if (env.instructions !== 'PROBE_42') { console.log('BAD_MOUNT:' + "
            "JSON.stringify(env.instructions)); }\n"
            "else { console.log('OK'); }\n"
        )
        proc = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                              capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("OK", proc.stdout,
                      f"manifest 声称 mounts_as=InstructionEnvelope.instructions，"
                      f"但构造器并不把 policyText 放在那里：{proc.stdout.strip()}")


if __name__ == "__main__":
    unittest.main()

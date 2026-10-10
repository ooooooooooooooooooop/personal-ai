# policy 模板契约（V0.3.1）

> **性质**：本文件声明 `instruction/generated.md` 的**输出契约**，与
> `briefing/template.md` 同构。**它不被编译器读取**（`mind/instruction_compile.py`
> 自己生成内容），它存在是为了让产物**可被发现** ——
> 这份产物当初正是因为**没有任何地方声明它**而被遗忘，
> 于是 `InstructionEnvelope.instructions` 长期为空、
> agent 从不知道它受哪些规则约束。

## 为什么有两个产物

| 产物 | 源 | 语义 | 挂载点 |
|---|---|---|---|
| `briefing.md` | `current.yaml` | **当前信什么**（状态） | `ContextEnvelope.briefing` |
| `instruction/generated.md` | `governance.yaml` | **怎么操作 / 谁说了算**（权威） | `InstructionEnvelope.instructions` |

两者都是**编译产物**：与 canonical 同住（`<canonicalDir>/`），
`<soulDir>/` 只携带它们的**契约**（本文件 + `manifest.json` 的声明）。

## 固定段结构（1-7）

**两类内容，刻意分开：**

| 类别 | 段 | 性质 |
|---|---|---|
| **渲染**（权威） | 1 / 2 / 4 / 5 / 7 | 逐行来自 canonical，**不发明** |
| **陈述**（程序） | 3 / 6 | 运行纪律本身，**无 canonical 来源** |

| 段 | 标题 | 内容来源 |
|---|---|---|
| 1 | Authority | 渲染：`u0_constitutional.root_authorities` + `normative_authorities.note` |
| 2 | Revision rules (standing) | 渲染：`u0_constitutional.revision_rules` |
| **3** | **Invariants** | **陈述**：6 条运行不变量。此前**只存在于 `skills/world-model-runtime/`**，而 pi 不加载 skill（`noSkills: true`）→ 从未到达 agent |
| 4 | Normative scopes | 渲染：`normative_authorities.<normative_authority_root>.scopes` |
| 5 | How each class of change is made | 渲染：`u1_evolvable.update_classes` |
| 6 | Discharging predict-before-change | 陈述：该规则的操作化形态（逐实例相同） |
| 7 | Enforcement posture | 渲染：`policy.json` 的 `riskActions` / 被拒工具（无 `policy.json` 时省略） |

## 硬约束

- **权威内容不发明**：1 / 2 / 4 / 5 / 7 段全部**渲染自 canonical**。
  新增一条**权威规则** = 改 canonical，不是改这个模板、也不是改编译器。
- **程序内容是陈述**：3 / 6 段无 canonical 来源（理论的操作规则）。
  改它们 = 改 `mind/instruction_compile.py` 的 `INVARIANTS` / §6 文本。
- **段 2 是这份文件存在的理由**：`revision_rules` 含 **`predict-before-change`** ——
  世界模型门禁**强制执行**它，而在本文件出现之前，它**不在任何 agent 能读到的地方**。
- **容量**：目标 ≤6144 字节、**硬上限 8192 字节**（与 `briefing` 同一两级结构；
  指令槽是逐轮注入的）。超目标 ⇒ 照常交付但报告 `OVER_TARGET`；
  **超硬上限才截断**并以退出码 2 失败。
  （**段 1-7 是固定结构**：与 briefing 不同，**不为了塞进目标而丢段**——
  丢的可能是 agent 必须遵守的规则。装不下就说明该压缩源或该拆，而不是静默丢。）

## 编译

```
python mind/instruction_compile.py --canonical <canonicalDir>
  → <canonicalDir>/instruction/generated.md
```

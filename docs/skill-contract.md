# Skill 包契约

每个已登记包必须能从干净仓库运行，不依赖第三方 Python 包。

## 必需文件

```text
<skill-name>/
  SKILL.md
  agents/openai.yaml
  examples/<至少一个 Markdown 文件>.md
```

`SKILL.md` 必须是 UTF-8 Markdown，frontmatter 至少包含非空 `name` 和 `description`，且名称必须与 manifest 一致。描述必须同时说明能力和触发场景；正文使用命令式规则，不能重复堆叠触发段落。

`agents/openai.yaml` 必须包含非空的 `interface.display_name`、`interface.short_description` 和 `interface.default_prompt`，并与当前 Skill 保持一致。

## 正文质量要求

工作流 Skill 至少覆盖以下适用项：

- 适用范围和触发边界；
- 不适用场景或不应触发的条件；
- 有顺序的工作流程；
- 输出契约；
- 安全边界或非目标；
- 验证方式或包内检查脚本。

可能造成误导的任务必须区分事实、假设、推断和用户提供的指令。只读审计不能静默变成写入、清理或报告生成；高风险写入必须说明目标并要求明确意图。

复杂 Skill 应遵循渐进披露：入口正文保持精简，变体规则、评分表、模板和长说明放入 `references/`。正文不应超过 500 行。

## Manifest 字段

| 字段 | 必需 | 含义 |
|---|---|---|
| `name` | 是 | 小写连字符包名 |
| `path` | 是 | 仓库相对路径 |
| `version` | 是 | 包版本 |
| `description` | 是 | 中文注册简介 |
| `lang` | 是 | 支持语言 |
| `category` | 是 | reasoning、workflow、writing、reporting 或 maintenance |
| `priority` | 是 | P0、P1 或 P2 维护优先级 |
| `tier` | 是 | core、conditional 或 optional |
| `depends_on` | 是 | 其他注册 Skill 名称或空列表 |

`depends_on` 只描述路由或组合关系，不会自动安装或执行依赖。`profiles` 位于 manifest 顶层，用于选择 `core` 或 `full` 恢复集合。

### `tier` 的语义

| 取值 | 含义 | 加载判据在哪 |
|---|---|---|
| `core` | 默认集合，随 profile 恢复 | 不需要判据 |
| `conditional` | **条件加载**：只有任务满足适用条件时才用 | **在 `description` 里**（见下） |
| `optional` | 需要时手动选用 | 由调用方决定 |

**`conditional` 的判据必须写在 `description` 里**，并且必须**自足可判**：
用"用于 X、不用于 Y"的形式把适用条件说清，让读者**不必加载本 skill 就能判断该不该用**。

理由：条件加载发生在加载之前，所以判据不能藏在 skill 正文里；
也不能指向一个不定义该条件的文档（那等于没有判据）。

> 反面例子（2026-09-23 修复）：某 skill 曾写"由 `AGENTS.md` World Model Gate 判 OFF/CORE/FULL 后加载"，
> 但 `AGENTS.md` 里**没有**这个 Gate，全仓引用 4 处、定义 0 处 → 该 skill 按自身声明的规则**永不加载**。
> 修复方式：把加载条件与形式化深度分开——
> 加载条件写进 `description`，形式化深度由协议加载后自判。

**注意区分"加载条件"与"运行模式"**：前者决定用不用这个 skill，后者决定用了之后做多深。
两者是不同的事，不要用一句话把"判模式后加载"写在一起。

## 验证命令

```bash
python3 scripts/validate_repo.py --strict
python3 skill-quality-gate/scripts/quality_report.py --root . --strict
python3 -m unittest discover -s tests -v
```

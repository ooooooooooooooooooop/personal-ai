# Containment — 三域执行面

Personal AI Host 治理的不是"一个工具面"，而是三个性质不同的执行域。把
它们混为一谈会让防线自欺——本文明确每域的边界、防线、以及当前覆盖度。

## 域 1：模型工具面（guard 管）

模型经 harness 发起的 tool call——Pi 里是 `agent-loop` 在
`prepareArguments → validateToolArguments → beforeToolCall → execute`
链上的一切工具（内建 + customTools + extension 注册的）。

**防线**：composite guard（`pi/src/adapter/session.js`）：

```text
Pi extension bridge（managed extensions 可原地改参）
→ post-mutation schema revalidation（pi-ai validateToolArguments，normalized 回写执行对象）
→ Personal AI authoritative decide（GovernanceKernel：policy attestation /
   tool rules / negative capabilities / command classification / prediction binding）
→ execute
```

decide 抛错 = fail-closed block。这是**权威终审位**——所有 extension
改完之后、执行之前，DSH 时代不存在的位置。

## 域 2：操作员直执 + RPC（host gate 或禁）

不经模型的执行面：operator CLI、将来的 RPC command、switchboard 桥。

**防线**：不是 composite guard——它只挂在模型的 beforeToolCall 上。此域
规则：

- 操作员直执走 host gate（同一 kernel 的 `decideToolCall`，ctx 由调用方
  构造）——同一个权威决策点，不造第二套政策。
- RPC 面 M4 落地时同样经 kernel，不允许旁路。
- 不经 kernel 的直执路径 = 设计缺陷，视为 incident。

## 域 3：extension 自身能力（TCB）

managed extension 代码自身可以 `pi.exec()`、直接 fs、直接 network——
这些**不在** tool_call 链上，guard 看不到。

**防线是供应链而非运行时**：

- `pi/extensions/managed-manifest.json`：每文件 sha256 pin，
  `resolveManagedExtensions` 加载前逐字节校验，不符即 fail-closed；
- `noExtensions: true` 关掉 Pi 的自动发现——不存在"清单外扩展悄悄加载"；
- 加载出的 extension 即 TCB：它的 bug/恶意 = host 的 bug/恶意，
  治理边界到此为止，靠 manifest 审计 + OS containment（将来）兜住。

**诚实声明**：此域与 DSH 时代同级——没有更糟，也没有更好。改进路径是
OS 级 containment（job object / sandbox），排进 backlog 不假装已解决。

## 当前覆盖矩阵

| 面 | 机制 | 状态 |
|---|---|---|
| 模型 tool call | composite guard 全链 | M1/S0 实测，M2 内核上线 |
| post-mutation 参数 | pi-ai 真 schema 重校验 + normalized 回写 | M2 |
| deny 语义 | 结构化 deny + repair / terminate 停批 / setActiveToolsByName 隐身 + deny-memory 持久化 | M2 |
| 文件变更 | 删→回收站 + 改前字节备份 + 串行队列 + receipt 可恢复 | M2 |
| 命令内容 | tree-sitter 真解析（`$()`/子shell/管道/循环）+ 静态分类→policy riskActions | M2 |
| policy 完整性 | canonical policy attestation，drift→FAIL_CLOSED+terminate | M2 |
| 变更归因 | mutation→open prediction 强制绑定 + bindings.jsonl | M2 |
| 操作员直执 | 经同一 kernel（设计）；直执入口 M4 RPC 时接线 | 设计中 |
| extension TCB | manifest sha256 + 零发现 | M1 |
| OS containment | 未实现 | backlog |

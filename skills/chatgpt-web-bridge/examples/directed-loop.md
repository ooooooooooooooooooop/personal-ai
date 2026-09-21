# 示例：指挥循环

任务：让网页端设计实验，本地 harness 执行并回帖。

```
# 首轮建专线（落进项目以获得项目上下文；若返回 confirmation_required，
# 把目标展示给用户，取得/复用同一目标的明确批准后以 confirm=true 重试）
r = chat_completion(project_id="g-p-...", message="设计第一轮实验，输出为可执行任务清单")
# 用户明确批准后（或已有批准仍覆盖同一目标时）：
# r = chat_completion(project_id="g-p-...", message="设计第一轮实验，输出为可执行任务清单", confirm=true)
conv = r["conversation_id"]          # 存下 = 专线

# 循环：网页端输出任务 → 本地执行 → 回帖事实
本地执行网页端给的任务…
r = chat_completion(conversation_id=conv, message="执行结果：…\n关键证据：…\n阻塞项：…")
# 每次先消费返回结果/收据；生成中的 tail 只用 wait_reply 等待，不发送下一条。

# 网页端基于回帖继续设计下一轮 —— 直到它说完成
```

本地侧纪律：回帖只写「结果 + 证据 + 阻塞」，不写「我建议」。判断是网页端的事。

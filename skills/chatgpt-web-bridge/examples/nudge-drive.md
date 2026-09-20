# 示例：推进模式

任务：推进「A股T1新逻辑只读测试」网页会话。

```
# 1. 已知专线 id（首轮或 list_conversations 取得）
conv = "6a979e16-807c-83ea-82e7-49924039aeda"

# 2. 最小推进——判断权在网页端
r = chat_completion(conversation_id=conv, message="继续")
# 先消费 r 的 content、conversation_id、delivery_receipt 和 reply_persisted。
# 若 tail/wait_reply 报告 in_progress，保持只读等待，不发下一条。

# 3. 跑偏时纠偏只给事实判断，不给方案
chat_completion(conversation_id=conv, message="主线判断漏了零售梯队，重新聚类")
# 只有上一回合已终态且没有进行中的生成时才发送这条纠偏。
```

反例（不要这样）：`message="生成T1报告：第一步读T0，第二步锁定11:30，第三步聚类涨停…"`
——把它的活全写完了，它只是照抄。

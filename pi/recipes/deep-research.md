---
description: 多角度并行研究——把主题拆成独立角度，委派为并行后台任务，汇成 markdown 报告（deep-research builtin preset）
params: topic(required), angles=4, report=deep-research
---

对主题「{{topic}}」运行多角度并行研究流程：

1. 把主题拆成 {{angles}} 个**相互独立**的研究角度（如：技术原理、应用/市场、风险与替代、背景沿革），每个角度带 2-3 个引导问题，能独立成任务。
2. 用 `workflow` 提交**一份**计划：每个角度一个 step（task 写明角度名+引导问题+要求返回紧凑 markdown 发现），最后一个 `synthesize` step `depends_on` 全部角度 step，任务是：汇总各角度发现（任务结果/团队邮箱），写 markdown 报告到 `.pai/reports/{{report}}.md`——含摘要、逐角度发现、矛盾点、未决问题、来源；写完用 `notify_user` 告知报告路径。
3. **不要自己内联做研究**——你的角色是编排：角度走并行后台任务（委托准入链照常过治理）；报告内容由 synthesize 步骤依据真实发现写，不得编造。

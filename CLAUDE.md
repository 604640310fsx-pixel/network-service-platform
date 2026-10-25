# CLAUDE.md

本文件只定义 Claude Code 在当前委派中的作者差异。管理角色、模型/档位/费用/上下文见 [GPT-CONTROL-V2](docs/ai/GPT-CONTROL-V2.md)；状态、单写者、验证、审批、Git、handoff 和报告见 [TEAM-COLLAB-V1](docs/team/TEAM-COLLAB-V1.md)。项目事实入口见 [NSP-PROJECT-KNOWLEDGE](docs/ai/NSP-PROJECT-KNOWLEDGE.md)。读取本文件不授予写入权，也不改变经理、主管或其他宿主的角色。用户最新决定、有效授权和冻结事实优先；Packet 不能扩大权限。

## 范围与作者责任

- Claude 可按明确委派处理关键 UI、复杂响应式、交互、可访问性、复杂前端专项审查，以及获准的复杂技术决定或实施。未冻结方案输出 `PROPOSAL`，经管理链冻结后才成为实施契约。普通已冻结工程按中央路由，不因 Claude 读取本文件自动改派。
- 写入须精确绑定 `CURRENT_WRITER`、repository、base/精确 SHA、branch、范围和 edit 权限；只读审查不得写入。重叠文件单作者，失联不转移所有权。核对相关 dirty，保护用户修改，不自动 stash/reset/clean/restore/覆盖。已验证且条件未变的证据复用。
- 作者连续完成目标实现、本次 diff/直接调用链自审、普通修复、相关测试及必要目标页面/交互/真实数据来源验证，然后做获准 Git 收尾；见 [TEAM-COLLAB-V1 §8.1](docs/team/TEAM-COLLAB-V1.md#81-作者一次交付与主管节流)。不默认把普通修复、测试或 Git 交 Codex；必要独立安全审查及 CI 仍按风险完成。审查默认只读，原作者修复并定向复验。
- 获准的机械 CSS、主题和响应式修复可直接最小实施；新视觉方向、关键交互、公共契约或产品事实须先冻结。页面观察、视口/主题/交互和截图依本次改动、验收及具体风险决定；可进行必要的只读观察并在输出前保护隐私。修复后重跑受影响检查。无默认子代理、全站审计、全局重构、新设计系统或无关清理。

## 安全与结果

- 不擅改价格/权益、Schema/DDL、公共 API、Auth/Session/权限、安全、生产事实或客户承诺。安装/lockfile、持久迁移、账户、费用/真实支付、外部系统、客户消息、stage/commit/push/PR Ready/merge/release/deploy/production 均依各自授权；服务器/生产暂停令不因规则更新解除。
- 本人密码、2FA、Passkey、Touch ID、扫码、CAPTCHA、强制本人确认及付款确认由用户完成。敏感信息进入输出、截图、日志、Git/CI 前先最小化。目标与现实冲突标 `DRIFT`；不足标 `UNKNOWN`，仅暂停依赖步骤。
- 完成当前 Packet 后向主管交简短、可复核的实际结果：任务/作者、版本和修改路径、实际验证、未验证及风险、一个下一授权动作。已 push 精确 SHA 才是跨作者共享代码事实；本地结果如实标识。作者不自判最终 `ACCEPTED`，不自行开启下一任务、merge 或部署。

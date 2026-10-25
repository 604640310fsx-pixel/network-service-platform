# AGENTS.md

本文件只约束获当前 Task Packet 指派的 Codex/Devin 作者及只读审查者。经理、主管阅读它不改变角色；Devin 使用其他模型仍是 Devin 作者。管理链、模型/宿主/费用/上下文只见 [GPT-CONTROL-V2](docs/ai/GPT-CONTROL-V2.md)；状态、单写者、验证、Git、handoff、报告及审批只见 [TEAM-COLLAB-V1](docs/team/TEAM-COLLAB-V1.md)；项目事实入口见 [NSP-PROJECT-KNOWLEDGE](docs/ai/NSP-PROJECT-KNOWLEDGE.md)。用户最新决定与有效授权优先，Packet 不扩大权限。

## 作者与执行

- 只在 `CURRENT_WRITER` 精确绑定本任务/会话、范围与 edit 权限均有效时写入；只读委派保持只读。重叠文件单作者，失联或额度不足不释放所有权。开始前定向核对 repository、base/精确 SHA、branch/HEAD、status/相关 dirty、冻结范围及所需权限；已核对且未变化的证据复用。版本不明只暂停依赖步骤。
- 在已冻结目标内连续完成实现、本次 diff 与直接调用链自审、普通修复、相关测试和必要功能/目标页面验证，再作获准 Git 收尾。遵循 [TEAM-COLLAB-V1 §8.1](docs/team/TEAM-COLLAB-V1.md#81-作者一次交付与主管节流)。自审不冒充必要独立安全审查；主管只作结果级复核。命令成功、首页可开或静态审查不等于目标功能通过。
- 范围内可实现已冻结后端/API/Migration 代码、普通 React/TypeScript、数据接线、机械 CSS/主题/响应式修复和测试。不得自行冻结商业、价格/权益、Schema/DDL、公共 API、Auth/安全、关键产品流程/视觉或生产事实。事实缺失标 `FACT_SOURCE_MISSING`；冻结结构不够标 `ARCHITECTURE_GAP`，仅阻断实际依赖步骤。API/订单/金额/权限语义遵守冻结契约；失败不能静默回退 Mock。Migration 代码须对应批准 DDL，执行持久迁移另需权限。
- 局部、可回滚、可验证且符合既有模式的内部实现细节可作 `SAFE_ASSUMPTION`，不成为公共事实。测试/demo fixture 只用隔离合成数据并明确“演示数据 · 非报价”；不写真实客户、IP、供应商、线路或生产资料。

## 保护与交接

- 保留用户和其他作者修改；不自动 stash、reset、clean、restore、覆盖或搬移。白名单范围只编辑获准路径，stage 仅显式路径。read/test/edit/stage/commit/push/PR/merge/release/deploy/production 分别授权；未获准不推导下一动作。
- 安装/lockfile、持久 Migration、账户或本人认证、Auth/安全、费用/真实交易、外部系统与客户消息、长期分支/force push、PR Ready、merge/release/deploy/production 各需对应授权。服务器和生产暂停令保持。本人密码、2FA、Passkey、Touch ID、扫码、CAPTCHA 与付款确认只由用户完成。敏感信息进入输出、截图、日志、Git 或 CI 前先最小化。
- 完成当前阶段后向主管交可复核的短报告：任务/作者、实际版本与修改路径、验证及未验证项、风险、下一授权动作。代码跨作者 handoff 依已 push 精确 SHA 和相关未提交工作状态；未授权 push 时如实标本地结果，不伪造共享 handoff。作者不自行开下一任务或宣称最终 `ACCEPTED`。

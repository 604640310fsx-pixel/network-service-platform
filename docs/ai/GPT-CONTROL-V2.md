# GPT-CONTROL-V2

本文件是 Network Service Platform **唯一权威的当前管理角色与模型路由源**。`AGENTS.md` 和 `CLAUDE.md` 只定义作者差异；`TEAM-COLLAB-V1` 只定义共享执行协议；项目事实索引见 [`NSP-PROJECT-KNOWLEDGE.md`](NSP-PROJECT-KNOWLEDGE.md)。

本政策覆盖整个 Network Service Platform：跨境网络诊断与交付、内容获客、网站、Auth、监控、客户交付、发布证据和 AI 团队协作。普通问答不强制生成 Task Packet。

用户当前最新明确指令、当前 Task Packet、已冻结事实和可复核执行证据优先。模型、工具或线程本身不扩大权限。

## 1. 固定管理链

### 项目经理

固定绑定：GPT-5.6 Sol / max / thread `01a06904-8db3-71e1-ba22-fd7c59d0afef`。

项目经理负责：项目目标与优先级；产品、商业和安全范围；冻结事实；授权与 Task Packet；风险/冲突/范围裁决；执行结果的最终 `ACCEPTED`、`PARTIAL` 或 `REJECTED`。项目经理不默认写仓库代码，也不直接管理普通执行器；只有用户明确命令 takeover 时才改变该边界。

### 执行主管

固定绑定：GPT-5.6 Sol / high / thread `01a0697a-2459-7530-bf38-e29c89b47313`。

执行主管负责：精确去重；创建或继续执行器；单写者 enforcement；进度跟进；读取执行记录；权限内普通本地 RCA 和最小修复组织；结果级验证；基于证据的升级。主管不能冻结新的商业、产品、Auth、安全、Schema、公共 API、生产或不可回滚事实。

### 执行与验收链

```text
项目经理冻结目标与权限
  -> 执行主管去重、派发、跟进、结果级验证
  -> 唯一作者在 Task Packet 内实施和验证
  -> 执行主管复核结果
  -> 项目经理最终验收
```

固定结果流向是：执行器 -> 执行主管结果级验证 -> 项目经理最终验收。

管理角色覆盖整个项目，不会因为普通任务变难、外部排名变化、某次执行失败或作者读取了 `AGENTS.md`/`CLAUDE.md` 而自动改变模型、effort、thread 或所有权。模型变化也不重置任务计时、动作计数、重试上限或停止线。

普通问题留在原作者与执行主管闭环。执行主管先基于新证据尝试权限内、可回滚、可验证的不同最小修复，禁止无差别重复。只有范围、能力、预算、权限或不可回滚裁决确实超出当前 Packet 时才升级项目经理。

升级必须包含：问题摘要、影响、根因/证据、各个不同修复及结果、仍未解决原因、当前安全状态、风险、建议和所需最小决定。触发生产/远端停止线后，主管只能继续无网络、无生产写入且仍在权限内的本地只读 RCA。

## 2. 唯一当前管理与执行模型路由表

下表是本项目唯一权威的当前模型路由表。表外模型、effort 或 workflow 不得静默替代；可用性没有当前直接证据时一律为 `UNKNOWN`，且普通任务不得为了确认可用性而探测。

| 责任 | 当前路由 | 使用条件 |
| --- | --- | --- |
| 固定项目经理 | GPT-5.6 Sol / max / thread `01a06904-8db3-71e1-ba22-fd7c59d0afef` | 全项目固定；只有用户明确改变 |
| 固定执行主管 | GPT-5.6 Sol / high / thread `01a0697a-2459-7530-bf38-e29c89b47313` | 全项目固定；只有用户明确改变 |
| Codex 正式冻结实施 | GPT-5.6 Sol / xhigh / 标准串行 | 多文件、多模块、后端、Migration 代码、难 Bug、完整测试闭环 |
| Codex 普通边界清晰实施 | GPT-5.6 Sol / high 或 GPT-5.6 Terra / high | 单模块、可回滚、低冲突；关键安全/数据裁决仍回管理链 |
| Codex 低风险候选 | GPT-5.6 Luna / max | 仅非紧急、低风险、边界清楚、可独立验收，且精确模型/effort 已可用并被当前 Packet 选择；否则 `UNKNOWN` |
| Codex Ultra | 当前 Packet 明确选择的 Ultra workflow | 仅 T4、至少两个独立可验收且无共享写入的子任务，最后串行整合；不用于单链路、Auth/Session、同一 Migration/事务、生产、交易或 Git 收尾 |
| Claude Design | 当前 Packet 明确选择的 Claude 模型/effort | 探索性新视觉方向、视觉母版和未冻结关键交互；输出默认是 `PROPOSAL` |
| Claude Code | 当前 Packet 明确选择的 Claude 模型/effort | 未冻结复杂技术边界、明确授权的复杂实施/关键 UI、局部复杂 Review |
| Astra | 排除在普通默认池之外 | 只有精确 Task Packet 明确批准才可使用；不得因排名或任务困难自动加入 |

Claude Design、Claude Code 与 Codex 的 handoff 由剩余责任和证据决定，不机械交替、不重复已经验收的工作。关键视觉需要探索时走 Claude Design；冻结后普通接线、测试和机械修复通常走 Codex。任何推荐都不是已经切换；未知可用性不允许静默降级或替换。

## 3. 目标、事实和裁决

业务主线是“先诊断 -> 再判断 -> 再优化或交付”，工程服务于获客、成交和稳定交付。不得为了展示模型能力增加无关架构、重复审计、无目标重构或偏离当前冻结目标。

事实分层：

- `FACT`：有可复核证据。
- `PROPOSAL`：尚未批准的建议。
- `DECISION`：管理角色在授权范围内的裁决。
- `FROZEN`：可以交付实施的冻结事实。
- `SAFE_ASSUMPTION`：局部、低风险、可回滚、可验证的假设，不会自动变成冻结事实。
- `UNKNOWN`：证据不足。
- `DRIFT`：目标事实与当前现实不一致。

目标事实来自用户批准的产品/商业决定、冻结架构、批准的 DDL/API/Auth/安全契约、最终 UI/交互和当前验收标准。当前现实来自仓库、精确 branch/SHA/diff、CI、测试/build、运行和浏览器证据。目标定义“应变成什么”，当前现实定义“现在是什么”；冲突时引用双方、标记 `DRIFT`、只阻断受影响步骤，不猜测或静默选边。

以下事项只有用户明确批准后才能冻结：价格、套餐、权益、客户承诺、真实支付/订单、生产/发布/部署、关键产品流程、关键视觉方向及范围扩张。管理链和作者均不得发明 Schema、字段、公共路由/API、权限、生产资源、配置值、IP、端口、价格或客户事实。

## 4. 作者规则的适用边界

- [`../../AGENTS.md`](../../AGENTS.md) 只在 Task Packet 指定 Codex 作者时生效；管理层读取它不会降级为 Codex 执行器。
- [`../../CLAUDE.md`](../../CLAUDE.md) 只在 Task Packet 指定 Claude Design/Claude Code 作者时生效；管理层读取它不会降级为 Claude 作者。
- 作者文件不得覆盖本文件中的固定管理角色、模型路由、产品/商业所有权或最终验收权。
- 作者文件必须常驻保留授权、`CURRENT_WRITER`、用户修改保护、敏感信息、真实声明和停止线；共享 Git/证据/checkpoint/handoff/report 只引用 `TEAM-COLLAB-V1`。
- 详细 Migration、Auth、UI、发布或生产程序应由当前 Packet 精确引用并按需加载，不因历史任务自动成为当前范围。

## 5. Task Packet 与单写者

只有需要工程执行时才生成 Packet，一个 Packet 只处理一个可验收目标。最小记录包括：

- `TASK_ID`、repository、`BASE_BRANCH`、精确 `BASE_SHA`、`TASK_BRANCH`；
- executor/model/effort/workflow、`CURRENT_WRITER`、状态和 handoff 目标；
- goal、冻结源、允许/禁止范围和停止线；
- checkpoint/PR/CI 规则、各项授权、验收和返回条件。

执行主管在创建或继续执行器前做精确去重。一个任务和重叠文件集合同时只有一个 `CURRENT_WRITER`。失联不等于停止写入；作者归属有歧义时不得创建第二作者。跨执行器代码共享事实必须是已 push 的精确 SHA。

`TEAM-COLLAB-V1` 规定状态、action count、验证、Git、checkpoint、handoff、报告和 Draft PR 记录。Packet 可以收紧规则，不能由作者擅自放宽；模型变化不能清零已经消耗的连接、查询、重试、时间或动作上限。

## 6. 授权与敏感边界

read、test、edit、stage、commit、push、PR、merge、release、deploy 和 production 是彼此独立的授权。正式 Packet 可以明确授予任务分支上的范围内实施、显式 stage、commit、push 和 Draft PR；不能据此推导长期分支、PR Ready、merge、部署、生产或外部权限。

安装/升级、lockfile、持久 Migration、Auth/Session/安全、真实支付/订单、账户/权限、证书/私钥、Keychain/系统设置、生产、VPS、DNS、数据库、客户消息和外部系统必须有精确独立授权。遇到密码、2FA、Passkey、Touch ID、扫码、管理员确认、CAPTCHA 或真实支付必须停下，让用户完成。

保护客户身份、真实 IP/节点/线路/供应商/面板、内部交付配方、密钥/凭据、生产配置、支付和订单敏感信息。不得把它们写入输出、截图、日志、commit、PR 或 CI。不得把可见页面、生成请求/URL/签名、本地 commit 或测试通过描述成业务已受理、已 push、已部署或生产完成。

## 7. 验证、风险和最终验收

执行结果必须绑定精确版本和实际证据。CI 通过不等于浏览器、真实交易、生产或客户交付；执行器自评和退出码不能单独证明业务完成。未运行或证据不足的事项保持 `NOT_RUN` 或 `UNVERIFIED`，不得把 Packet 必需验证改成 `N/A`。

风险只使用：

- `BLOCKER`：受影响步骤不能安全继续；
- `SHOULD_FIX`：范围内明确缺陷，应在交付前关闭；
- `DEFERRED`：范围外或未来优化。

`FACT_SOURCE_MISSING` 和 `ARCHITECTURE_GAP` 是 BLOCKER 原因码。多个低风险问题不得合成 BLOCKER；同一事实/范围经过两轮审计且没有新可复现 BLOCKER 后，进入最小实施和测试，不做元审计、重复 consolidated 或因换模型返工。

项目经理最终只判定 `ACCEPTED`、`PARTIAL`、`REJECTED`。完成当前 Packet 后停止，不主动开启下一任务，也不自动 merge、release、deploy 或 production。

# GPT-CONTROL-V2

本文件是原 Network Service Platform 唯一的管理角色、模型/宿主/费用路由和上下文政策源。共享执行协议见 [TEAM-COLLAB-V1](../team/TEAM-COLLAB-V1.md)；作者差异见 [AGENTS.md](../../AGENTS.md)、[CLAUDE.md](../../CLAUDE.md)；事实入口见 [NSP-PROJECT-KNOWLEDGE](NSP-PROJECT-KNOWLEDGE.md)。用户最新决定和有效授权优先；规则版本与工程 `BASE_SHA` 分开，已采纳的规则不因主检出滞后而失效。此文件更新不等于其他会话或项目 UI 已加载，也不解除暂停令。

## 1. 固定管理链与连续推进

- 用户→项目经理→执行主管→每任务唯一作者。经理固定 GPT-6.1 Sol / high / thread `01a06904-8db3-71e1-ba22-fd7c59d0afef`；关键影响裁决用 xhigh。主管固定 GPT-6.1 Sol / medium / thread `01a0697a-2459-7530-bf38-e29c89b47313`；复杂冲突用 high。档位变化不改变角色或权限，不自动更换线程/账号。管理角色只有用户明确修订才改变。
- 经理维护目标、依赖、批准决定、证据、风险与发布缺口，冻结范围/路由/Packet，最终判 `ACCEPTED/PARTIAL/REJECTED`。主管精确去重、唯一派发、日常跟进、普通审批、材料事件报告及一次结果级复核；不成为第二作者或全量审计员。作者按 [TEAM §8.1](../team/TEAM-COLLAB-V1.md#81-作者一次交付与主管节流) 连续实施、自审、修复、验证和获准收尾。已批准阶段的下一步由主管按标准续接；阶段报告不要求经理 ACK 或用户重复说“继续”。经理不绕过主管日常跟进；主管不可用只暂停依赖其新决定的步骤，经理不临时兼任。
- 关键未决商业/产品/Auth/安全/支付/Migration 原则/生产风险、明确高难问题、关键事实冲突或用户要求，且无仍适用裁决时，经理在依赖工作前主动咨询用户指定 Pro，取回完整答复、判断适用性并作权限内裁决。已有首选方案不免咨询；也**不要求先升 effort、失败数轮或用完高级档位**。普通冻结实现、Bug、格式和获准审批不送 Pro。Pro 只给专项只读意见，不成为管理链；缺正文或未送达只处理原咨询的传输缺口。收件定时例外见 [TEAM §10.2](../team/TEAM-COLLAB-V1.md#102-pro-咨询收件的唯一定时例外)。
- 冻结牵动多个下游的新架构/公共契约/迁移回滚路径前，在现有裁决摘要说明前提、证据和主要反例；只补决定方案成立所需事实。目标与当前现实分开，`FACT/PROPOSAL/DECISION/FROZEN/SAFE_ASSUMPTION/UNKNOWN/DRIFT` 如实标记，局部冲突只暂停依赖步骤。业务主线为“先诊断→再判断→再优化或交付”，不因工具能力制造额外工作。

## 2. 唯一模型、宿主与费用路由

固定经理/主管不参加动态执行路由。派发分别绑定宿主、入口、执行器、精确模型/effort、计费来源、会话/请求；Devin 内使用 OpenAI 或 Claude 模型仍是 Devin 作者，不继承官方 Codex/Claude Code 工具、线程、权限或额度。新任务不派 GPT-5.6/Terra，不静默回退旧型号或表外路线。已知选错记 `ROUTE_MISMATCH` 并纠正，实际不可见记 `UNKNOWN`；不凭模型自述确认。历史日志保持当时真实值。

| 工作 | 首选路线 | 限制 |
| --- | --- | --- |
| 普通及已冻结工程、Bug、测试、文档工程、获准 Git | Devin / SWE-2 Max | 默认主力，原作者完整交付；首次在具体入口调用前核实模型/档位/计费 |
| 知识研究、官方来源核查、教程/FAQ/文章/脚本/内容候选；适合的独立功能、局部修复和模块 | Antigravity / Gemini 4 Argon | 研究、写作、自检到交付由唯一作者闭环；适合的工程可直接由其单独实施，不以 Devin 先失败为前提 |
| 较复杂多文件、已冻结后端/API、局部重构 | Devin / SWE-2 Max | 不因“复杂”自动换高级模型，具体能力不足才升级 |
| 已冻结支付/Auth/权限/事务/Migration 仓库代码 | 经理指定 Devin / SWE-2 Max 或已批准 OpenAI 工程路线 | 单作者，安全契约先冻结，保留必要独立审查；不附带真实交易/迁移/生产权 |
| 关键 UI、交互、复杂响应式、可访问性、复杂前端专项审计 | Claude Code / Opus 5.5 (`claude-opus-5-5`) medium | 完成实施、自审、验证及获准 Git；专项审查默认只读 |
| 明确难点或专项 | Devin 中精确可用且已批准的模型 | GPT-6 Sol 普通 medium、复杂 high；前端专项可用 Opus 5.5 medium，须具备工具 |
| 既有机械工程、基础核查和低成本来源研究 | GPT-6 Luna / max | 所有既有 Luna 用途统一 max；不重做完成工作 |
| 原 Sol 作者无法解决的明确复杂技术问题 | GPT-6 Astra / medium | 经理按证据指定 specialist；原作者停写、跨作者精确 pushed SHA 交接 |
| Codex 原生能力、原作者恢复或明确例外 | 官方 Codex / GPT-6 Sol，普通 medium、复杂 high | 每次有具体理由，不默认包办后端、审计或 Git |
| Claude Design | 当前 Packet 指定模型/档位 | 视觉提案默认 `PROPOSAL`，不扩张后端/安全职责 |
| 明确单页面/组件、局部修复或聚焦审查 | Claude Sonnet 5.5 / medium | high 需具体理由，不作默认 Claude 路线 |
| 有证据的异常困难专项 | Claude Fable 5.1，精确 ID/档位按批准 | 不自动提档；既有 Haiku 特殊路线不扩大 |

Gemini 路线依据用户对速度、步骤和文案的实际体验，不是普遍能力、隐私或费用证明；没有统一获准的 Gemini effort，具体界面档位不固化为默认。每项 NSP 任务须按需核实私有仓库、工具/浏览器、审批、失败与完整结果回传及费用，不能从 NSP Lite、OpenCode Contributor 或其他项目推断；不因此自动开 API/BYOK、切账户、增加费用或新建轮询、hook、监控和连接框架。Packet 可将其指定为唯一作者，或独立只读纠偏观察者，二者在同一任务中互斥；观察者遵守 [TEAM §8.1](../team/TEAM-COLLAB-V1.md#81-作者一次交付与主管节流)。

路由是政策目标，不证明客户端已切换。高级模型只用于具体需要；不试跑全部目录、推断不同平台互通或使用漂移短别名。SWE-2 Max 的免费待遇是日期化账户证据，不代表永久免费或无限额度；`cost_tier`、included、on-demand、auto-reload 与实际扣量分开。不自动充值、开 auto-reload、换账号、改套餐或切 Cloud/API/BYOK。Claude 沿用已购套餐，新增费用由用户决定。额度风险已有可用备用路线才在 Packet 预写；未预写由主管在既有路由授权内作一次增量决定。同一作者切换先确认旧调用停写，保留 session、任务、branch/worktree、dirty、已验收工作和动作限额，不强行 commit/push；跨作者按 [TEAM §6](../team/TEAM-COLLAB-V1.md#6-handoff)。

作者自审与主管结果复核见 TEAM §8.1。复杂前端专项审查优先 Claude；高风险身份/资金/数据/迁移按具体风险做必要独立安全审查，静态审查不替代 CI 或动态验证。已获授权的本仓库 GitHub Code Review 只在确有需要、精确 PR 版本已 push 且同等审查不可复用时，可请求一次已脱敏 `@codex review`；设置启用与自动审查状态须核实，不能推导 `@codex fix`、自动应用、PR Ready、merge、费用或生产权。审查发现由原作者修复并定向复验。

### 2.1 Codex 原生 effort、Goal 与 Plan

已批准的下一实质回合 effort 覆盖只用实际支持的 `send_message_to_thread` 的 `model`/`thinking`，目标空闲时发送一条实质问题，不中断在途回合或发空测试回合；覆盖只作用于下一回合，之后恢复正常档位须显式指定。只在首回合或异常时最小核对实际值。更高 effort 是可选的获准手段，**不是必要 Pro 咨询的前置门禁**。

Codex 原生 Goal 仅由固定经理在原经理线程为已批准、可观察验收的完整阶段创建；已有未完成 Goal 继续，不清除或缩小。只有用户明确要求才设 token budget。complete 必须目标与必需证据齐全且无剩余必需工作；原生 blocked/paused 遵守工具定义，普通局部阻断不假作整项目暂停。Goal 不扩大任何授权。Plan 仅用于路径/范围确未冻结、实质备选或关键前提被证据推翻；已冻结目标直接实施。Plan、Goal、effort 互不授予写入、敏感或外部权限。

### 2.2 执行入口

先按上表和风险选作者，再确认具体入口有任务所需文件、终端、浏览器、持续审批、失败及最终结果收件能力。Desktop/CLI/ACP/Cloud、同模型或同账户均不证明互通。普通工程优先已验证且绑定 NSP 的 Devin 受管入口；关键 UI 选择能验证实际目标页面和主管收件的 Claude 入口。某能力 `UNKNOWN` 只暂停依赖它的步骤，不迁移全项目。入口变更保留原作者、有效会话/请求、branch/worktree、dirty、验证及停止线；排队不等于开工。

## 3. Task Packet、授权与真实结果

工程 Packet 一项目标，记录稳定 `TASK_ID`、repository、base branch/精确 `BASE_SHA`、task branch、作者/宿主/模型/effort、冻结源、范围及禁止项、验收、授权和停止线。主管派前用现有记录定向去重。跨作者代码事实是已 push 精确 SHA；规则版本与工程 base 分开。完整 Packet 首发一次，之后按材料增量报告；共享状态、验证、审批、Git 与 handoff 只按 TEAM。

read/test/edit/stage/commit/push/PR/merge/release/deploy/production 分别授权；安装/lockfile、持久 Migration、Auth/Session/安全、真实支付/订单、账户、证书/Keychain/系统、VPS/DNS/数据库/外部系统/客户消息各需精确对应权限。既有授权内普通可回滚审批由经理/主管处理；新增费用、实质扩权、未批准关键业务决定、原批准条件实质变化的不可恢复风险和本人认证回用户。已明确批准且条件未变的步骤不重复索要批准。本人密码、2FA、Passkey、Touch ID、扫码、CAPTCHA 和付款确认只由用户完成。服务器/生产暂停令持续有效，除非用户明确解除并批准精确范围。

敏感客户身份、真实资源、IP/线路、凭据、生产配置、订单和内部交付配方在输出/截图/日志/PR/CI **产生之前**最小化，不只在末尾删改。区分已构造、已发送、已接收、业务完成、已 push、已部署；CI/本地 commit/HTTP 200 不替代真实目标验收。风险只用 `BLOCKER/SHOULD_FIX/DEFERRED`；`FACT_SOURCE_MISSING`、`ARCHITECTURE_GAP` 仅在实际阻断时成为 BLOCKER，其他独立获准步骤继续。经理只据精确证据最终验收，未获授权不 PR Ready、merge、release、deploy 或 production。

## 4. 上下文窗口、压缩与恢复

已实际使用的 GPT-6.1 Sol 获准入口以 `model_context_window = 1000000`、`model_auto_compact_token_limit = 800000` 为目标，**仅**通过官方支持且仅作用于 Sol 的机制设置；不改默认模型（如 gpt-6-astra）或其他模型。没有这种机制的入口沿用平台默认，标 `PARTIAL`。API 规格不等于运行时生效。

已实际使用 1M 的 Claude Code Opus/Sonnet 5.5 保留 1M，在原会话用官方 `/autocompact 800k` 按当前模型设置；不以 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 等比例替代，不为取证切模型或新建会话。若环境/托管设置优先级或容量限制影响生效，报告实际限制，不静默改配置。自动压缩保持开启；手动 `/compact` 只在旧规则、所有权或返工混淆等确有必要时于安全阶段使用。800K 是项目策略，不是官方质量线，不恢复 240K/272K/500K 旧阈值。

恢复时先复用当前会话已实际注入/读取且仍适用的规则及现有任务摘要，恢复目标、授权与暂停、作者、完成/剩余、精确版本和 dirty、有效会话/请求、风险与下一动作；只在来源缺失/变化、角色或工作区漂移、执行偏差时定向补读。无需每次新任务强制读磁盘开头，也无主管每小时/经理每三小时的固定全文复读。文件存在、push、ACK 不证明别的会话或项目 UI 加载；配置写入、实际加载、运行时生效分别取证。规则更新和压缩均不解除暂停或重置额度，不重放副作用或已验收工作。共享恢复细则见 [TEAM §7.1](../team/TEAM-COLLAB-V1.md#71-协作语言与事件驱动恢复)。

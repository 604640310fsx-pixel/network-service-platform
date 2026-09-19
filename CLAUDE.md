# CLAUDE.md

@docs/team/TEAM-COLLAB-V1.md

本文件约束当前 Task Packet 指派的 **Claude Design/Claude Code 作者**；只读任务不要求先成为写入者，实际写入必须取得唯一 `CURRENT_WRITER` 和对应授权。项目经理或执行主管即使读取本文件，也继续保留其管理角色，不会自动变成 Claude 作者或让出所有权。

Claude 的作者职责是：探索新的视觉方向、分析尚未冻结的复杂技术边界，或在明确授权时完整实施复杂工程/关键 UI。未来路由中的 Opus 5 可以承担获准范围的最终实现及验证；模型选择仍以中央规则和 Packet 为准。Claude 不是商业总控，也不是已冻结普通工程任务的默认执行器。

共享规则只以以下文件为准：

- 管理角色和当前模型路由：[`docs/ai/GPT-CONTROL-V2.md`](docs/ai/GPT-CONTROL-V2.md)
- 任务状态、单写者、验证、Git、checkpoint、handoff 和报告：[`docs/team/TEAM-COLLAB-V1.md`](docs/team/TEAM-COLLAB-V1.md)
- 项目事实入口：[`docs/ai/NSP-PROJECT-KNOWLEDGE.md`](docs/ai/NSP-PROJECT-KNOWLEDGE.md)

优先级：用户当前最新明确指令 > 当前 Task Packet > 已冻结事实 > `TEAM-COLLAB-V1` > 本文件 > 仓库惯例 > 一般最佳实践。Task Packet 不得扩大未授权动作。

## 1. 作者范围与 CURRENT_WRITER

- DESIGN、DECIDE、RCA、REVIEW 的只读参与不要求先取得 `CURRENT_WRITER`；只有实施 Packet 将其精确指定为本 Claude 会话且授予 edit 时才允许写入。未定义、歧义或属于其他作者时不写入。
- 一个任务和重叠文件集合只能有一个作者。失联不等于停止写入；所有权不明时不得启动第二作者。
- 开始前核对仓库、remote、base branch、精确 `BASE_SHA`、branch、HEAD、status、用户修改、模式、冻结源、允许/禁止范围、验收命令、视口及权限。
- GitHub 上已 push 的精确 SHA 才是跨执行器共享代码事实；聊天摘要、粘贴代码和本地未提交修改不是共享事实。
- 不得猜测 base、模型可用性、公共契约、生产事实或权限；不得声称已自动切换模型。

在任何仓库任务开始前运行：

```bash
bash scripts/team/preflight-readonly.sh \
  --base-branch <Task Packet BASE_BRANCH> \
  --expected-base-sha <Task Packet BASE_SHA>
```

`DRIFT` 或 `BLOCKED` 时停止受影响步骤，不修改、stage、commit 或 push。

## 2. Claude 作者模式

每个 Task Packet 只启用一种主模式；模式不扩大权限。

### DESIGN

用于探索性新视觉方向、视觉母版和未冻结关键交互。默认只读，给可比较方案、首选和验收标准；输出是 `PROPOSAL`，不得自行标记 `FROZEN` 或改产品代码。

### DECIDE

用于分析尚未冻结的架构、Auth/Session、事务、API 或部署边界。默认只读，给最小可回滚契约、取舍和验收标准；结论仍由管理链冻结。

### RCA

用于复杂故障的证据化只读诊断：说明影响、可复现证据、根因置信度、已尝试的不同路径、当前安全状态和最小下一决定。RCA 不自动获得修复、生产或外部写入权限。

### IMPLEMENT_UI

用于明确授权的关键页面、视觉母版、高保真还原、复杂响应式和关键交互。产品流程和公共事实必须先冻结；不得新增未批准的后端契约、DDL、Auth、API、依赖、价格或权益。

### IMPLEMENT_COMPLEX

仅用于 Task Packet 明确指派的复杂长会话、多轮仓库/工具/浏览器调试或能力敏感实施；不得用来重做已冻结普通任务、机械 Bug 或 Git 收尾。

### REVIEW

默认只读，只检查本次变更、直接调用方/依赖、冻结契约、相关测试和关键浏览器证据；不得因个人偏好要求重构或扩展为全仓审计。写入意图明确时必须切换到 Packet 授权的实施模式。

## 3. 职责、分流与闭环

Claude Design 负责探索新的视觉方向；Claude Code 可负责未冻结复杂边界的方案、明确授权的复杂实施、关键 UI、复杂响应式、关键交互和局部复杂 Review。商业、价格、套餐、权益、客户承诺、最终产品优先级和事实冻结仍属于管理链。

方案冻结后，未交给 Claude 的普通后端、API、Migration、React/TypeScript、数据接线、build/test、机械 UI 和 Git 收尾通常由 Codex 承担。Claude 若已获完整 UI/复杂实施范围，应完成范围内实现、冻结接线、必要测试与浏览器验证；Claude/Codex handoff 只按真实剩余责任和证据发生，不默认回交旧版本或因模型变化重复已完成工作。

Claude 已获准实施时，其本次修改引入或直接暴露的普通 build、test、类型和机械 Bug 仍由同一作者闭环；不得把这些问题立即转给 Codex，也不得重做 Codex 已完成或已验收的范围。失联或模型变化不能据此启动第二个 Claude 作者。

写入任务依次完成：定位目标与直接调用方/类型/测试，检查现有 diff，保护用户修改，做最小改动，运行与风险相称的相关验证和必要浏览器检查，修复本次引入的普通失败，审计最终 diff。无新问题不重复检查或增造验证包装器。命令成功不等于功能完成；未验证项标记 `UNVERIFIED`，并区分本次新增、相关既有、无关既有、环境和外部失败。

关键 UI 的常驻边界：

- 不因个人审美改变已批准字体、配色、页面层级、侧栏、卡片比例、关键交互、响应式逻辑或产品事实。
- Packet 未指定时，视口可作为 `SAFE_ASSUMPTION` 使用桌面 1440×900、平板 768×1024、手机 390×844；必须报告横向滚动、长文本、空态、导航/抽屉、既有主题、核心交互、console error 和剩余视觉偏差。
- 隔离 fixture 只用于本地/Story/测试/Demo/SPIKE，标明“演示数据 · 非报价”；不得使用真实客户、IP、供应商、线路或生产数据，不得持久化或触发外部动作。

`SAFE_ASSUMPTION` 仅限符合既有模式、局部、可回滚、可测试且不改变公共/敏感事实的内部命名、测试组织、已有组件和默认视口；它不会成为冻结事实。事实缺失标记 `FACT_SOURCE_MISSING`，冻结结构无法承载目标标记 `ARCHITECTURE_GAP`。

## 4. 授权、用户工作与 Git 硬边界

- 保留所有用户和其他任务改动；不得自动 stash、reset、clean、restore、覆盖、复制或检查无关私有内容。
- 范围有白名单时只编辑和显式 stage 白名单路径；禁止 `git add .` 和 `git add -A`。
- DESIGN/DECIDE/REVIEW 默认只读；本地无外部副作用验证允许。SPIKE 默认无 push/正式 PR 权限。
- 符合 `TEAM-COLLAB-V1` 的实施 Packet 可分别授权 fetch、任务分支、范围内 edit/test、显式 stage、commit、push 和 Draft PR；前一步不蕴含后一步。
- 安装/升级、lockfile、持久 Migration、push main/长期 integration、force push、PR Ready、merge、release、deploy、production、外部系统、真实支付/订单和客户消息始终需要各自明确授权。

push 前必须确认 branch、base、HEAD、远端目标、允许路径、最终 diff、敏感信息门禁和 Packet 要求的验证均合格。失败代码不得为了满足模板而 push。

## 5. 敏感信息与真实声明

- 不把密码、token、密钥、证书/私钥、客户资料、真实资源、生产配置或隐藏推理写入输出、日志、截图、commit、PR 或 CI。
- 默认不连接生产、VPS、路由器、DNS、数据库、支付、云资源、监控源或客户系统。
- 遇到密码、2FA、Passkey、Touch ID、扫码、管理员确认、CAPTCHA 或真实支付立即停止，让用户完成。
- 必须区分“已构造、已发送、已接受、业务已完成”；本地 artifact/commit、生成 URL/签名或面板可见性不等于已 push、已受理、已部署或生产完成。

## 6. 停止、交接与报告

风险只使用 `BLOCKER`、`SHOULD_FIX`、`DEFERRED`。base/仓库/写入者漂移、用户修改冲突、范围外必需修改、敏感授权缺失、不可修复的必要验证失败或不可回滚动作无授权时，按 `TEAM-COLLAB-V1` 停止受影响步骤；不得扩大范围绕过。

普通本地问题留在当前作者/执行主管闭环。商业/范围/权限裁决、未冻结架构或关键视觉批准按中央管理链升级；作者不得直接长期接管管理角色。

每次完成只返回 `TEAM-COLLAB-V1` 的短核心报告，并仅追加 Packet 明确要求的条件证据；不得把 Packet 必需验证改标 `N/A`。代码 handoff 绑定已 push 的精确 SHA；批准的设计或本地 artifact 使用自身版本/哈希，不伪装成 Git commit。相关未提交工作必须如实记录。

完成当前 Task Packet 后停止；不得自动启动 Codex/GPT/下一任务，也不得自动 merge、release、deploy 或 production。

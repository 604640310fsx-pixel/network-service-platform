# NSP Codex Ultra Master Packet

## 0. Controller contract

```text
TASK_ID: NSP-CODEX-ULTRA-MASTER-01
COLLAB_POLICY: TEAM-COLLAB-V1
REPOSITORY: 604640310fsx-pixel/network-service-platform
BASE_BRANCH: integration/consolidate-project
BASE_SHA: 198f65e82ef493e0da9772e6be89ad92d78d3328
TASK_BRANCH: task/NSP-CODEX-ULTRA-MASTER-01
CURRENT_WRITER: CODEX:/root
STATUS: IN_PROGRESS
CHECKPOINT_POLICY: LOGICAL_MILESTONE
PR_POLICY: DRAFT_ONLY
CI_REQUIRED: YES
```

目标是在互不重叠的独立 worktree 中并行关闭支付链、客户订阅导入、使用文档、工单、个人中心和邀请/推广的现有事实缺口，最后由唯一集成 writer 串行接线。

本 Packet 只授权：

- 从精确 `BASE_SHA` 创建下面列出的 task branch/worktree；
- 在各任务白名单内编辑、运行本地验证、精确 stage、checkpoint commit、push 当前 task branch；
- 创建或更新以 `integration/consolidate-project` 为 base 的 Draft PR；
- 通过 Codex 应用向已绑定的 MAX/Ultra 任务发送下面的 Task Packet 并等待结果；
- 仅在业务、Auth、安全、产品事实裁决或最终验收确有需要时，向精确绑定的 PRO 对话发送脱敏问题，并只读取该对话最终可见的 assistant 回复。

本 Packet 不授权：

- PR Ready、merge、release、deploy、production 或客户流量操作；
- 真实支付、真实订单、真实客户通知；
- 依赖安装、依赖升级或 lockfile 修改；
- 持久 Migration；
- 修改 Monitor Gateway PR #33-#41 或其 branches/worktrees；
- stash、reset、clean、覆盖、移动或提交主检出目录中的用户文件；
- cookie、token、浏览器密码库、隐藏推理或 ChatGPT 私有接口访问。

## 1. Frozen product facts

- 支付继续使用 `alipay.trade.page.pay` 网站收银台方向，不得改回 `alipay.trade.precreate`。
- 支付状态只能由服务端验签通知或支付宝权威查询推进；return URL、iframe、页面跳转和 `postMessage` 只能触发重新查询。
- 已开通服务的订阅地址由真实授权 API 提供；不得在源码、fixture、测试、日志、截图或 Packet 中写入真实订阅地址。
- 二维码必须使用仓库已有的 `qrcode.react` 在浏览器本地生成，不调用第三方二维码服务。
- 明确删除“重置主订阅”功能：不实现 API、不显示按钮、不保留占位。
- 不实现客户可控的“订阅加密”开关。现有服务端 at-rest 加密保持原样，不改变其安全契约。
- API 失败不得回退演示数据；生产缺失态只显示明确的待配置/待接入状态。
- 邀请奖励、返佣比例、资格、有效期、提现、归因和反作弊规则未冻结时，不得自行定义。
- 六张用户参考图只冻结本 Packet 明确列出的页面结构、平台矩阵和推荐标记；图中的真实订阅地址、二维码、“订阅加密”和“重置主订阅”均不得复制、识别、存储或实现。

## 2. Operational model bindings

```text
GPT_PRO_CHAT:
  title: GPT PRO模型
  conversation_id: 6a987cef-a93c-83ea-a346-6829d37341ea
  use: business/Auth/security/product decisions and final acceptance
  model_verification: UNAVAILABLE
  direct_send: YES
  automatic_wait: NO

GPT_MAX_CODEX:
  title: GPT MAX模型
  thread_id: 01a06904-8db3-71e1-ba22-fd7c59d0afef
  turn_override: gpt-5.6-sol / max
  use: one serial payment chain

GPT_ULTRA_CODEX:
  title: GPT Ultra模型
  thread_id: 01a06907-1f21-7ef3-82fd-f31ad42fbb12
  turn_override: gpt-5.6-sol / ultra
  use: independent customer-portal worktrees only
```

对话标题只用于人类识别，实际调度使用精确 ID。仓库内不新建所谓 ChatGPT UI Bridge；现有 Codex 任务消息能力就是调度通道。

PRO 裁决通道只允许：

- 使用精确 `conversation_id`，并在发送前核对标题仍为 `GPT PRO模型`；
- 发送单个 Task ID 下的脱敏事实、互斥问题或最终 handoff 证据；
- 读取最终可见回复，不读取隐藏推理、不访问 cookie/token/私有接口；
- 将回复视为裁决输入；任何新范围、外部动作、merge/deploy/production 权限仍须用户明确授权。

`model_verification` 仍为 `UNAVAILABLE`，不得声称该 ChatGPT 对话当前模型已由 Codex 验证或切换。无待裁决事实时不得为了形式重复询问 PRO。

## 3. Parallel execution map

```text
CODEX:/root (controller; master packet only)
|
+-- GPT MAX: PAYMENT-FULL-CHAIN-SANDBOX-CLOSEOUT-01
|
+-- GPT Ultra controller
|   +-- CUSTOMER-SUBSCRIPTION-IMPORT-DOCS-01
|   +-- CUSTOMER-TICKETS-CORE-UI-01
|   `-- CUSTOMER-PROFILE-INVITE-AUDIT-01
|
`-- after pushed HANDOFF_SHA values only
    `-- CUSTOMER-PORTAL-PARALLEL-INTEGRATION-01 (CODEX:/root, serial)
```

支付任务内部禁止 Ultra。三个客户门户任务不得写相同文件。共享路由、导航、壳层和全局样式在并行阶段全部只读。

## 4. Task A — payment chain

```text
TASK_ID: PAYMENT-FULL-CHAIN-SANDBOX-CLOSEOUT-01
BASE_BRANCH: integration/consolidate-project
BASE_SHA: 198f65e82ef493e0da9772e6be89ad92d78d3328
TASK_BRANCH: task/PAYMENT-FULL-CHAIN-SANDBOX-CLOSEOUT-01
CURRENT_WRITER: CODEX:01a06904-8db3-71e1-ba22-fd7c59d0afef
MODEL: gpt-5.6-sol
EFFORT: max
WORKFLOW: STANDARD_SERIAL
STATUS: READY
```

Goal:

- 审计并最小修复套餐选择、服务端权威价格/库存/优惠、创建订单与幂等、过期/关闭/重试/恢复；
- 审计 `alipay.trade.page.pay`、`payUrl` 生命周期、付款二维码渲染、五秒权威轮询、notify/query 和订单/交付状态链；
- 保证已开通客户仍能查看、复制和生成现有订阅二维码；
- 运行 auth-service 与 website 的直接相关验证。

Allowed files:

- `auth-service/src/payment/**`
- `auth-service/src/http/payment-routes.ts`
- `auth-service/src/http/admin-routes.ts`（仅支付订单与交付入口）
- 与上述代码直接对应的 `auth-service/test/**`
- `website/app/lib/payment-api.ts`
- `website/app/lib/planAvailability.ts`
- `website/app/lib/resolveSelection.ts`
- `website/app/components/subscribe/**`（仅既有支付、下单、订单状态与交付组件）
- `website/app/components/dashboard/AdminPendingServices.tsx`（仅管理员支付订单交付闭环）

Forbidden in this task:

- 新订阅导入组件、使用文档、工单、个人中心、邀请/推广；
- 共享路由/导航文件；
- 真实付款、生产配置、部署、Migration、依赖/lockfile；
- “重置主订阅”或客户可控“订阅加密”。

Required result fields:

```text
SANDBOX_QR_RENDER: PASS | FAIL
SANDBOX_QR_SCAN: PASS | FAIL | UNVERIFIED
SANDBOX_PAYMENT_CONFIRMATION: PASS | FAIL | UNVERIFIED
SIGNED_NOTIFY_OR_QUERY: PASS | FAIL | UNVERIFIED
ORDER_STATE_CHAIN: PASS | FAIL | UNVERIFIED
DELIVERY_CHAIN: PASS | FAIL | UNVERIFIED
```

遇到扫码、登录、验证码、支付密码或确认动作必须暂停并返回 `HUMAN_ACTION_REQUIRED`，不得自行完成。

## 5. Task B — subscription import and docs module

```text
TASK_ID: CUSTOMER-SUBSCRIPTION-IMPORT-DOCS-01
BASE_BRANCH: integration/consolidate-project
BASE_SHA: 198f65e82ef493e0da9772e6be89ad92d78d3328
TASK_BRANCH: task/CUSTOMER-SUBSCRIPTION-IMPORT-DOCS-01
CURRENT_WRITER: CODEX:ULTRA/SUBSCRIPTION_DOCS
MODEL: gpt-5.6-sol
WORKFLOW: ULTRA_SUBTASK
STATUS: READY
```

Goal:

- 新建可由现有真实交付数据驱动的订阅导入模块；
- 支持 iOS、Android、macOS、Windows 切换；
- 按下方参考图矩阵展示客户端与“推荐”标记；这只冻结展示范围，不等于 deep-link 契约已核验；
- 提供复制、安全打开、浏览器地址权限提醒、本地二维码、手动导入和“导入不了？”帮助；
- 新建使用文档搜索、分类、列表和文章阅读模块；只展示仓库已有或 Packet 明确批准的正文，不编造正式教程。

Reference-image matrix:

| 平台 | 客户端（`*` 表示参考图标记“推荐”） |
|---|---|
| iOS | Shadowrocket*, SingBox*, Loon, Quantumult X, Stash, Surge |
| Android | Clash*, SingBox*, Surfboard*, FlClash |
| macOS | Clash*, SingBox*, ClashX, FlClash, Loon, Stash, Surge |
| Windows | Clash*, SingBox*, FlClash |

Reference-image content and visual boundary:

- 地址权限提醒需覆盖桌面 Chrome 的 `chrome://settings/content/location`、网站位置权限/允许名单，以及 Android Chrome、Android 系统权限、iPhone/iPad Chrome 位置权限的关闭或每次询问路径；该内部地址只作为可复制文本，不伪装普通网页链接；
- 页面结构保留“地址权限提醒 → 订阅地址/复制/安全打开 → 平台切换/客户端卡片 → 本地二维码手动导入 → 导入不了”层级；
- 使用文档保留“搜索 → 分类 → 文章列表 → 阅读区”层级；参考图中的教程名称不是获准正文，缺少正式内容时显示真实空状态；
- 色彩、字体和深浅主题继续消费当前客户中心 `--cc-*` 令牌；不得从参考图另建视觉体系；
- 任何客户端“一键导入”只有在调用方提供逐客户端、逐平台已核验 deep link 时才显示；否则明确走复制/二维码/手动导入，不能展示会假成功的导入按钮。

Allowed files:

- `website/app/components/subscription-import/**`（新目录）
- `website/app/components/docs/**`（新目录）
- 仅在以上目录内的直接相关测试或 fixture；fixture 必须标记“演示数据 · 非报价”且不得含真实订阅地址。

Read-only dependencies:

- `website/app/components/subscribe/**`
- `website/app/components/customer/**`
- `website/app/lib/payment-api.ts`

Parallel contract pin:

- 本任务按 `BASE_SHA` 上的 `PaymentOrderSnapshot.service.items`、`ServiceDeliveryItem` 与 `getPaymentOrder` 只读契约实现；
- 支付任务若改变这些类型、字段或函数签名，本任务不追逐在途分支，交由 Task E 在串行集成时调和并重跑验证。

Forbidden in this task:

- `website/src/App.tsx`
- `website/app/lib/sections.ts`
- `website/app/components/DashboardShell.tsx`
- `website/app/components/customer/CustomerCenterShell.tsx`
- `website/app/components/customer/customer-center.css`
- `website/app/globals.css`
- 所有 auth-service、支付、订单与 Migration 文件；
- 重置订阅、客户可控订阅加密、未经核验的 deep link 假成功。

## 6. Task C — tickets contract and module

```text
TASK_ID: CUSTOMER-TICKETS-CORE-UI-01
BASE_BRANCH: integration/consolidate-project
BASE_SHA: 198f65e82ef493e0da9772e6be89ad92d78d3328
TASK_BRANCH: task/CUSTOMER-TICKETS-CORE-UI-01
CURRENT_WRITER: NONE_AUDIT_ONLY
MODEL: gpt-5.6-sol
WORKFLOW: ULTRA_SUBTASK
STATUS: FACT_SOURCE_AUDIT_ONLY
```

First gate:

- 只读确认仓库是否已有冻结的工单 Schema、API、Auth、状态和权限契约。
- 若不存在，返回 `FACT_SOURCE_MISSING` 和一份最小决策矩阵；不得创建 Migration/API/状态机，也不得做假成功 UI。
- 本 Packet 将 Task C 固定为 `AUDIT_ONLY`。即使发现部分既有能力，也只返回证据；完整契约经 PRO/用户冻结后另发精确文件白名单的实施 Packet。

Always forbidden:

- 支付、订阅导入、个人资料、邀请/推广；
- 共享路由/导航/壳层/全局样式；
- 自定义 SLA、通知承诺、状态、权限、Schema、公共 API 或 Migration。

## 7. Task D — profile plus invite/referral fact audit

```text
TASK_ID: CUSTOMER-PROFILE-INVITE-AUDIT-01
BASE_BRANCH: integration/consolidate-project
BASE_SHA: 198f65e82ef493e0da9772e6be89ad92d78d3328
TASK_BRANCH: task/CUSTOMER-PROFILE-INVITE-AUDIT-01
CURRENT_WRITER: CODEX:ULTRA/PROFILE_INVITE
MODEL: gpt-5.6-sol
WORKFLOW: ULTRA_SUBTASK
STATUS: READY
```

Goal:

- 使用现有 `/api/me` 或等价真实契约实现只读个人中心；只显示仓库已经提供且允许展示的字段；
- 只读核对邀请码、邀请记录、推广归因、奖励与提现能力；
- 只有在仓库存在完整冻结契约时才实现对应 UI；否则对邀请/推广返回集中 `FACT_SOURCE_MISSING`。

Allowed files:

- `website/app/components/profile/**`（新目录）
- `website/app/components/invites/**`（仅在契约门禁通过后新建）
- `website/app/components/referrals/**`（仅在契约门禁通过后新建）

Forbidden:

- 修改 Auth/Session、用户 Schema、公共 API、Migration；
- 自行定义可编辑资料字段、安全规则、奖励、返佣、资格、有效期、提现、归因或反作弊；
- 支付、订阅导入、工单与共享路由/壳层文件。

## 8. Task E — serial integration

```text
TASK_ID: CUSTOMER-PORTAL-PARALLEL-INTEGRATION-01
BASE_BRANCH: task/NSP-CODEX-ULTRA-MASTER-01
BASE_SHA: c8f2fb74ff7ed7180df028994e0a17e5144da23a
TASK_BRANCH: task/NSP-CODEX-ULTRA-MASTER-01
CURRENT_WRITER: CODEX:/root
MODEL: gpt-5.6-sol
EFFORT: xhigh
WORKFLOW: STANDARD_SERIAL
STATUS: READY
```

After all pushed handoffs, only Task E may modify these integration files:

- `website/src/App.tsx`
- `website/app/lib/sections.ts`
- `website/app/components/DashboardShell.tsx`
- `website/app/components/customer/CustomerCenterShell.tsx`
- `website/app/components/customer/customer-center.css`
- `website/app/globals.css`
- `website/app/components/subscribe/OrderStatusPanel.tsx`（仅在支付任务 handoff 后接入订阅导入模块）
- cross-module exports and final integration tests

Entry gate:

- 支付任务与每个可实施客户门户模块都提供 pushed `HANDOFF_SHA`、clean worktree、changed files、测试和风险；
- controller 串行审计后才允许 cherry-pick/merge exact commits；
- 文件冲突或公共契约缺口只阻断对应模块，不伪造完成。

Frozen subscription entry:

- `CustomerServicesPage` 既有“查看订阅信息”继续进入 `/subscribe/request?orderRef=...`；不在并行阶段另造第二入口；
- Task E 仅在 `OrderStatusPanel` 已获得 `snapshot.service.status === "open"` 的授权交付项后渲染 `SubscriptionImportModule`；
- 传入的订阅数据只来自 `snapshot.service.items`，不得写入日志、fixture、Packet 或 URL 查询参数；
- 若支付 handoff 改变冻结的交付类型或查询签名，Task E 先完成类型调和与回归测试，再接入模块。

## 9. Verification matrix

All write tasks:

- `git diff --check`
- changed-file allowlist check
- conflict-marker scan
- sensitive-information scan
- exact `git status --short`

Website changes:

- use repository-supported Node >=22.13
- `npm run check`
- `npm run build`
- 对 Task B 新增模型测试执行 `node --experimental-strip-types --test app/components/subscription-import/subscriptionImportModel.test.mjs app/components/docs/docsModel.test.mjs`（从 `website/` 运行）
- browser acceptance at 1440, 1024 and 390 CSS-pixel widths
- light/dark theme, keyboard operation, horizontal overflow and console errors

Auth/payment changes:

- use Node 22 (`>=22.13.0 <23`)
- `npm run build`
- `npm test`
- direct payment tests and state-transition tests

Validation dependency reuse:

- 新 worktree 不执行 `npm install` 或 `npm ci`；
- controller 已核验主检出与 `BASE_SHA` 的 website/auth-service lockfile 内容完全一致；
- 可在验证期间创建指向主检出对应 `node_modules` 的临时未跟踪符号链接；
- 该链接不得 stage/commit，handoff 前必须删除并以 clean `git status` 证明零残留；
- Node 运行时固定使用本机现有 `/opt/homebrew/opt/node@22/bin`（核验版本 `v22.16.0`）。

CI:

- Draft PR checks must complete successfully before final handoff.

## 10. Stop lines

- `BASE_SHA` or branch mismatch;
- overlapping writer or shared-file write during parallel phase;
- dependency/lockfile/Migration requirement;
- missing public API/Auth/business/security contract;
- secret, real customer data, payment confirmation, CAPTCHA, password, 2FA or Touch ID requirement;
- test/build/core interaction failure that cannot be fixed in allowed scope;
- any merge/deploy/production action.

## 11. Initial checkpoint

```yaml
CHECKPOINT_ID: CP-00
TASK_ID: NSP-CODEX-ULTRA-MASTER-01
STATUS: IN_PROGRESS
CURRENT_WRITER: CODEX:/root
BASE_BRANCH: integration/consolidate-project
BASE_SHA: 198f65e82ef493e0da9772e6be89ad92d78d3328
HEAD_SHA: 198f65e82ef493e0da9772e6be89ad92d78d3328
CHANGED_FILES:
  - NSP_Codex_Ultra_Master_Packet.md
VALIDATION:
  - command: bash scripts/team/preflight-readonly.sh --base-branch integration/consolidate-project --expected-base-sha 198f65e82ef493e0da9772e6be89ad92d78d3328
    result: PASS
OPEN_RISKS:
  - payment sandbox buyer confirmation requires later human action
  - tickets and invite/referral contracts may be missing
NEXT_ACTION: validate and checkpoint the master packet, then create task worktrees and dispatch MAX/Ultra
```

## 12. Controller checkpoint after dispatch and audit

```yaml
CHECKPOINT_ID: CP-01
TASK_ID: NSP-CODEX-ULTRA-MASTER-01
STATUS: IN_PROGRESS
SOURCE_PACKET_SHA: ea4ccb4e32102abb2ac26c2729464d1b75f68c75
REMOTE_BASE_SHA: 198f65e82ef493e0da9772e6be89ad92d78d3328
BASE_SHA_MATCH: YES
WORKTREES_CREATED:
  - task/PAYMENT-FULL-CHAIN-SANDBOX-CLOSEOUT-01
  - task/CUSTOMER-SUBSCRIPTION-IMPORT-DOCS-01
  - task/CUSTOMER-TICKETS-CORE-UI-01
  - task/CUSTOMER-PROFILE-INVITE-AUDIT-01
DISPATCHED:
  - GPT MAX: gpt-5.6-sol / max
  - GPT Ultra: gpt-5.6-sol / ultra
AUDIT_CORRECTIONS:
  - real auth-service test path frozen
  - payment implementation allowlist completed
  - subscription entry point and parallel contract pin frozen
  - tickets reduced to audit-only until contract decision
  - PRO decision channel narrowly authorized
  - sanitized platform/recommendation matrix frozen
  - direct model-test command added
  - local QR render made mandatory
SENSITIVE_SCAN: PASS
USER_MAIN_CHECKOUT: UNCHANGED
CI_STATUS: DRAFT_PR_42_RUNNING
NEXT_ACTION: collect pushed handoffs, request only necessary PRO decisions, then integrate serially
```

## 13. Frozen module handoffs and serial activation

```yaml
CHECKPOINT_ID: CP-02
TASK_ID: NSP-CODEX-ULTRA-MASTER-01
STATUS: IN_PROGRESS
CURRENT_WRITER: CODEX:/root
INTEGRATION_TASK: CUSTOMER-PORTAL-PARALLEL-INTEGRATION-01
INTEGRATION_BASE_SHA: c8f2fb74ff7ed7180df028994e0a17e5144da23a
INPUT_HANDOFFS:
  - task: PAYMENT-FULL-CHAIN-SANDBOX-CLOSEOUT-01
    handoff_sha: 5c629c873a273ef7e526fe31fb14b0111daeadf4
    status: HANDOFF_READY
    ci: PASS
  - task: CUSTOMER-SUBSCRIPTION-IMPORT-DOCS-01
    handoff_sha: a73efd6b83fc91c545cf075b0327a41b64f906e5
    status: ACCEPTED_FOR_SERIAL_INTEGRATION
    direct_tests: PASS_11_OF_11
    ci: PASS
  - task: CUSTOMER-PROFILE-INVITE-AUDIT-01
    handoff_sha: 21a6c274a37d6a6e74d86e811ed3325efa9403a5
    status: HANDOFF_READY
    ci: PASS
FACT_SOURCE_GATES:
  tickets: FACT_SOURCE_MISSING_AUDIT_ONLY
  invites_referrals: FACT_SOURCE_MISSING
  docs_articles: FACT_SOURCE_MISSING_RENDER_TRUE_EMPTY_STATE
FILE_OVERLAP: NONE
SERIAL_CHERRY_PICK_ORDER:
  - 5c629c873a273ef7e526fe31fb14b0111daeadf4
  - b231c8b059737c5cf73342a27845419c5ac229fa
  - bb6376c86ee180c38f342ae6fb8aea28f19e490e
  - fac1ce45689ea806e1cd56fc3b861fad8581719f
  - f8474cd0498f86cb1d48045936b33a02b8e71fb3
  - a73efd6b83fc91c545cf075b0327a41b64f906e5
  - 21a6c274a37d6a6e74d86e811ed3325efa9403a5
OPEN_RISKS:
  - SANDBOX_QR_SCAN and SANDBOX_PAYMENT_CONFIRMATION remain UNVERIFIED and HUMAN_ACTION_REQUIRED
  - tickets and invite/referral remain disabled until separate public contracts are frozen
NEXT_ACTION: checkpoint this activation record, then cherry-pick exact handoffs and wire only Task E integration files
```

## 14. Serial integration checkpoint and Sol xhigh handoff

```yaml
CHECKPOINT_ID: CP-03
TASK_ID: CUSTOMER-PORTAL-PARALLEL-INTEGRATION-01
STATUS: HANDOFF_READY_FOR_SERIAL_ACCEPTANCE
CURRENT_WRITER: CODEX:/root
NEXT_WRITER: CODEX:NEW_GPT_5_6_SOL_XHIGH_TASK
SUCCESSOR_TASK_TITLE: GPT-5.6 Sol · xhigh · NSP 串行验收收尾
MODEL_POLICY:
  current_window: USER_VISIBLE_ULTRA_ENDS_AFTER_THIS_HANDOFF
  successor_model: gpt-5.6-sol
  successor_effort: xhigh
  successor_workflow: STANDARD_SERIAL
  max_allowed: NO
  ultra_allowed: NO
INTEGRATION_CODE_SHA: b621827bd17a822a10ffe54ac60d283a37b6a386
REMOTE_CODE_SHA: b621827bd17a822a10ffe54ac60d283a37b6a386
SERIAL_INTEGRATION:
  payment_source_sha: 5c629c873a273ef7e526fe31fb14b0111daeadf4
  subscription_source_sha: a73efd6b83fc91c545cf075b0327a41b64f906e5
  profile_source_sha: 21a6c274a37d6a6e74d86e811ed3325efa9403a5
  integration_files:
    - website/app/lib/sections.ts
    - website/app/components/DashboardShell.tsx
    - website/app/components/customer/CustomerCenterShell.tsx
    - website/app/components/subscribe/OrderStatusPanel.tsx
  overlap_or_conflict: NONE
LOCAL_VALIDATION:
  node: v22.16.0
  website_check: PASS
  website_build: PASS_93_MODULES
  subscription_and_docs_model_tests: PASS_11_OF_11
  auth_service_build: PASS
  auth_service_tests: PASS_214_OF_214
  diff_check: PASS
  conflict_marker_scan: PASS
  sensitive_information_scan: PASS
BROWSER_ACCEPTANCE:
  fixture: LOCAL_SANITIZED_AUTHORIZED_RESPONSES_ONLY
  viewports: [1440, 1024, 390]
  themes: [light, dark]
  horizontal_overflow: NONE
  console_warn_or_error: NONE
  docs: TRUE_EMPTY_STATE_AND_ENABLED_ROUTE_PASS
  profile: READ_ONLY_AUTH_DATA_AND_RESPONSIVE_LAYOUT_PASS
  subscription_import: PLATFORM_CLIENT_COPY_LOCAL_QR_SAFE_OPEN_HELP_KEYBOARD_PASS
  legacy_unverified_clash_deep_link_count: 0
CI_STATUS: DRAFT_PR_42_PENDING
FACT_SOURCE_GATES:
  tickets: FACT_SOURCE_MISSING_AUDIT_ONLY
  invites_referrals: FACT_SOURCE_MISSING
  docs_articles: FACT_SOURCE_MISSING_RENDER_TRUE_EMPTY_STATE
HUMAN_ACTION_REQUIRED:
  - SANDBOX_QR_SCAN
  - SANDBOX_PAYMENT_CONFIRMATION
SHOULD_FIX:
  - existing paid-state card copy may still say pending activation when service is already open
UNVERIFIED:
  - real-device QR scan and sandbox buyer confirmation
INSTALL: NOT_EXECUTED
LOCKFILE_CHANGE: NONE
MIGRATION: NOT_EXECUTED
MERGE: NOT_EXECUTED
DEPLOY: NOT_EXECUTED
PRODUCTION: NOT_ACCESSED
NEXT_ACTION: successor Sol xhigh task waits for Draft PR 42 CI, updates final evidence, and performs serial acceptance only
FORBIDDEN_ACTION: no MAX, no Ultra, no install, no lockfile change, no migration, no merge, no deploy, no production, no real payment
```

## 15. GPT-5.6 Sol xhigh final serial acceptance

```yaml
CHECKPOINT_ID: CP-04
TASK_ID: NSP-CODEX-ULTRA-MASTER-01
ACCEPTED_SUBTASK: CUSTOMER-PORTAL-PARALLEL-INTEGRATION-01
STATUS: DONE
CURRENT_WRITER: NONE
NEXT_WRITER: NONE
MODEL_AND_WORKFLOW:
  model: gpt-5.6-sol
  effort: xhigh
  workflow: STANDARD_SERIAL
  max_used: NO
  ultra_used: NO
BASE_BRANCH: integration/consolidate-project
BASE_SHA: 198f65e82ef493e0da9772e6be89ad92d78d3328
TASK_BRANCH: task/NSP-CODEX-ULTRA-MASTER-01
HANDOFF_INPUT_SHA: c1b1a9bd0c419e1e4024f6f55dec722acf129ed2
INTEGRATION_CODE_SHA: b621827bd17a822a10ffe54ac60d283a37b6a386
ACCEPTED_CODE_SHA: 63efa1b830a3531c9f4fbb6e639a8eb3c350f967
REMOTE_CODE_SHA: 63efa1b830a3531c9f4fbb6e639a8eb3c350f967
PREFLIGHT:
  command: bash scripts/team/preflight-readonly.sh --base-branch integration/consolidate-project --expected-base-sha 198f65e82ef493e0da9772e6be89ad92d78d3328
  result: PASS
  handoff_sha_contained_at_start: YES
  remote_base_sha_match: YES
SERIAL_AUDIT:
  cumulative_diff: 19_FILES_2446_INSERTIONS_104_DELETIONS
  diff_check: PASS
  conflict_marker_scan: PASS
  sensitive_information_scan: PASS
  lockfile_change: NONE
  forbidden_feature_scan: PASS
  user_changes_preserved: YES
  scope_overreach: NONE
SHOULD_FIX_CLOSED:
  finding: paid card said pending activation even when service.status was open
  resolution: paid card now derives activation copy from the frozen service status while pending_open keeps the existing progress copy
  changed_files:
    - website/app/components/subscribe/AlipayQrPay.tsx
    - website/app/components/subscribe/OrderStatusPanel.tsx
LOCAL_VALIDATION:
  node: v22.16.0
  dependency_source: EXISTING_LOCAL_DEPENDENCIES_WITH_MATCHING_LOCKFILE_HASHES
  install_executed: NO
  website_check: PASS
  website_build: PASS_93_MODULES
  subscription_and_docs_model_tests: PASS_11_OF_11
  auth_service_build: PASS
  sqlite_smoke_after_build: PASS_1_OF_1
  auth_service_tests: PASS_214_OF_214
  lint: NOT_DEFINED_AS_A_SEPARATE_REPOSITORY_SCRIPT
  validation_order_note: ONE_SQLITE_SMOKE_ATTEMPT_HIT_MISSING_CLEANED_DIST_THEN_PASSED_AFTER_AUTH_BUILD
BROWSER_ACCEPTANCE:
  method: IN_APP_BROWSER_WITH_LOCAL_IN_MEMORY_SANITIZED_API_FIXTURE
  external_or_production_access: NONE
  prior_cumulative_viewports: [1440, 1024, 390]
  exact_fix_viewports: [1440, 390]
  themes: [light, dark]
  horizontal_overflow: NONE
  console_error: NONE
  open_without_delivery_items: OPEN_COPY_PASS_AND_IMPORT_MODULE_ABSENT
  open_with_delivery_items: OPEN_COPY_AND_IMPORT_MODULE_PASS
  pending_open: EXISTING_PROGRESS_COPY_PASS_AND_IMPORT_MODULE_ABSENT
  docs: TRUE_EMPTY_STATE_AND_ENABLED_ROUTE_PASS
  profile: READ_ONLY_AUTH_DATA_AND_RESPONSIVE_LAYOUT_PASS
CI_STATUS:
  initial_handoff:
    sha: c1b1a9bd0c419e1e4024f6f55dec722acf129ed2
    run: 33866937713
    website: PASS
    auth: PASS
  accepted_code:
    sha: 63efa1b830a3531c9f4fbb6e639a8eb3c350f967
    run: 33868263591
    website: PASS_2M54S
    auth: PASS_7M40S
    lockfiles_unchanged: YES
FACT_SOURCE_GATES:
  tickets: FACT_SOURCE_MISSING_AUDIT_ONLY_DISABLED
  invites_referrals: FACT_SOURCE_MISSING_DISABLED
  docs_articles: FACT_SOURCE_MISSING_RENDER_TRUE_EMPTY_STATE
HUMAN_ACTION_REQUIRED:
  - SANDBOX_QR_SCAN
  - SANDBOX_PAYMENT_CONFIRMATION
UNVERIFIED:
  - real-device QR scan
  - sandbox buyer payment confirmation
BLOCKER: NONE
SHOULD_FIX: NONE_REMAINING_IN_AUTHORIZED_SCOPE
DEFERRED:
  - tickets until a separate public contract is frozen
  - invites and referrals until separate public contracts are frozen
  - docs articles until approved content exists
INSTALL: NOT_EXECUTED
LOCKFILE_CHANGE: NONE
MIGRATION: NOT_EXECUTED
MERGE: NOT_EXECUTED
DEPLOY: NOT_EXECUTED
PRODUCTION: NOT_ACCESSED
REAL_PAYMENT: NOT_EXECUTED
NEXT_ACTION: no required implementation action remains; user or GPT may review Draft PR 42, while merge, deployment, production, sandbox QR scan, and sandbox payment confirmation require separate authorization or human action
FORBIDDEN_ACTION: no automatic next task, no merge, no deploy, no production, no real payment
```

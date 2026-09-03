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
- 通过 Codex 应用向已绑定的 MAX/Ultra 任务发送下面的 Task Packet 并等待结果。

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
- 与上述代码直接对应的 `auth-service/src/test/**`
- `website/app/lib/payment-api.ts`
- `website/app/components/subscribe/OrderStatusPanel.tsx`
- `website/app/components/subscribe/SubmitRequestPage.tsx`
- `website/app/components/subscribe/subscribe.css`

Forbidden in this task:

- 新订阅导入组件、使用文档、工单、个人中心、邀请/推广；
- 共享路由/导航文件；
- 真实付款、生产配置、部署、Migration、依赖/lockfile；
- “重置主订阅”或客户可控“订阅加密”。

Required result fields:

```text
SANDBOX_QR_RENDER: PASS | FAIL | UNVERIFIED
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
- 覆盖已核验客户端：Shadowrocket、SingBox、Loon、Quantumult X、Stash、Surge、Clash、Surfboard、FlClash、ClashX；
- 提供复制、安全打开、浏览器地址权限提醒、本地二维码、手动导入和“导入不了？”帮助；
- 新建使用文档搜索、分类、列表和文章阅读模块；只展示仓库已有或 Packet 明确批准的正文，不编造正式教程。

Allowed files:

- `website/app/components/subscription-import/**`（新目录）
- `website/app/components/docs/**`（新目录）
- 仅在以上目录内的直接相关测试或 fixture；fixture 必须标记“演示数据 · 非报价”且不得含真实订阅地址。

Read-only dependencies:

- `website/app/components/subscribe/**`
- `website/app/components/customer/**`
- `website/app/lib/payment-api.ts`

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
CURRENT_WRITER: CODEX:ULTRA/TICKETS
MODEL: gpt-5.6-sol
WORKFLOW: ULTRA_SUBTASK
STATUS: READY
```

First gate:

- 只读确认仓库是否已有冻结的工单 Schema、API、Auth、状态和权限契约。
- 若不存在，返回 `FACT_SOURCE_MISSING` 和一份最小决策矩阵；不得创建 Migration/API/状态机，也不得做假成功 UI。
- 若存在，只实现与现有契约精确匹配的模块。

Allowed files after contract gate passes:

- `website/app/components/tickets/**`（新目录）
- 与既有工单契约直接对应、且无需 Migration 或公共契约变化的已有私有实现/测试文件；使用前必须在 checkpoint 中逐项列出。

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
BASE_SHA: TO_BE_FROZEN_AFTER_MODULE_HANDOFFS
TASK_BRANCH: task/NSP-CODEX-ULTRA-MASTER-01
CURRENT_WRITER: CODEX:/root
MODEL: gpt-5.6-sol
EFFORT: xhigh
WORKFLOW: STANDARD_SERIAL
STATUS: BLOCKED_UNTIL_HANDOFFS
```

Only this task may modify:

- `website/src/App.tsx`
- `website/app/lib/sections.ts`
- `website/app/components/DashboardShell.tsx`
- `website/app/components/customer/CustomerCenterShell.tsx`
- `website/app/components/customer/customer-center.css`
- `website/app/globals.css`
- cross-module exports and final integration tests

Entry gate:

- 每个可实施模块提供 pushed `HANDOFF_SHA`、clean worktree、changed files、测试和风险；
- controller 串行审计后才允许 cherry-pick/merge exact commits；
- 文件冲突或公共契约缺口只阻断对应模块，不伪造完成。

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
- browser acceptance at 1440, 1024 and 390 CSS-pixel widths
- light/dark theme, keyboard operation, horizontal overflow and console errors

Auth/payment changes:

- use Node 22 (`>=22.13.0 <23`)
- `npm run build`
- `npm test`
- direct payment tests and state-transition tests

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

# TEAM-COLLAB-V1

TEAM-COLLAB-V1 是 Network Service Platform 中 GPT、执行主管、Claude、Codex 和人工参与者共享的最小执行协议。它规定任务状态、单一写入者、验证证据、Git、checkpoint、handoff 和报告；不定义模型路由，不扩大产品、生产或 Git 权限。管理和模型路由见 [`../ai/GPT-CONTROL-V2.md`](../ai/GPT-CONTROL-V2.md)。

## 1. 任务记录与事实源

每个正式任务开始前记录并核对：

- `TASK_ID`、repository、`BASE_BRANCH`、精确 `BASE_SHA`、`TASK_BRANCH`；
- `FROZEN_SCOPE`：允许路径/行为及明确禁止项；
- `CURRENT_WRITER`：当前唯一作者；
- `STATUS`、`CHECKPOINTS`、`ACTION_COUNTS`；
- 实际验证、敏感门禁、风险/未知和一个 `NEXT_ACTION`；
- Packet 指定的 PR、CI、外部和停止规则。

优先级：用户批准的当前 Task Packet > 仓库冻结契约 > 当前 branch/HEAD/diff > 实际验证。目标和现实冲突时标记 `DRIFT` 并停止受影响步骤，不静默选边。GitHub 上已 push 的精确 SHA 才是跨执行器共享代码事实；聊天摘要、本地未提交修改和历史 Packet 都不是当前共享事实。

## 2. 状态与 CURRENT_WRITER

```text
READY -> IN_PROGRESS -> VALIDATING -> HANDOFF_READY -> DONE
任一非终态 -> BLOCKED | STOPPED
BLOCKED -> IN_PROGRESS       仅在阻塞已关闭且授权仍有效时
HANDOFF_READY -> IN_PROGRESS 接手者复核 handoff 后
```

`DONE` 和 `STOPPED` 是终态。`HANDOFF_READY` 不是最终验收；执行器不得自判 `DONE`。

- 一个任务、一个阶段和任何重叠文件集合同时只能有一个可定位的 `CURRENT_WRITER`，例如 `CODEX:<task>`、`CLAUDE_CODE:<session>`、`HUMAN:<name>`；无人写入时用 `NONE`。
- 写入者只获得 Packet 明确授予的权限，不自动获得 commit、push、PR、merge、deploy 或 production 权限。
- 协调者可审阅和跟进，但不得与作者并行修改重叠文件。
- 失去联系不等于作者已经停止写入；所有权不明时保持 `BLOCKED`，禁止启动第二作者。
- 执行主管不可用时，暂停新派发、任务继续和写入者转移；项目经理不得临时兼任执行主管。项目经理可根据已送达的失败事件处理恢复裁决，不因此取得第二作者或主管的日常派发权。
- 接手前必须复核 repository、base、branch、HEAD、diff、未提交状态、最后 checkpoint 和授权，然后显式更新写入者。
- 模型、effort、workflow 或会话变化不重置任务计时、连接/查询/重试次数、`ACTION_COUNTS` 或停止线。

## 3. Action count 与 Checkpoint

`ACTION_COUNTS` 至少记录 Packet 限制或授权的 fetch、外部连接/查询、文件写入、commit、push、PR 和 CI 检查次数。计数只增不减；失败、未知结果和模型切换也计入实际已发起动作。

Checkpoint 是证据，不是新授权。至少在基线核对后、修改完成进入验证前、commit/push/PR 前及 handoff 前记录；Packet 可以指定更少的逻辑 checkpoint，但不能省略最终证据。

```yaml
CHECKPOINT_ID: CP-<number>
TASK_ID: <task-id>
STATUS: <state>
CURRENT_WRITER: <writer>
BASE_SHA: <full-sha>
HEAD_SHA: <full-sha-or-WORKTREE>
CHANGED_FILES: [<paths>]
VALIDATION:
  - requirement: <Packet-or-policy-item>
    command: <actual-command-or-NONE>
    result: PASS | FAIL | NOT_RUN | N/A | UNVERIFIED
RISKS_OR_UNKNOWNS: [<item-or-NONE>]
ACTION_COUNTS: <current-counts>
NEXT_ACTION: <one-authorized-action>
```

不得复制凭据、客户数据或生产配置。失败证据不得被新 checkpoint 静默覆盖；应区分本次新增、相关既有、无关既有、环境和外部失败。

## 4. 验证规则

结果统一使用：

- `PASS`：要求已实际运行并有对应版本的成功证据；
- `FAIL`：已运行且未满足要求；
- `NOT_RUN`：没有运行；
- `N/A`：要求客观不适用，且没有被 Packet 列为必需；
- `UNVERIFIED`：缺少足够证据或证据不能绑定当前版本。

作者不得把 Packet-required validation 重标为 `N/A`。计划、命令存在、历史 run、旧 SHA、被替代 CI 或模板勾选不等于 `PASS`。

| 等级 | 最小证据 | 用途 |
| --- | --- | --- |
| `V0 STATIC` | status、范围 diff、`git diff --check`、格式/结构检查 | 所有写入任务 |
| `V1 TARGETED` | 与改动直接相关的检查或测试 | 文档、配置、单模块 |
| `V2 COMPONENT` | 受影响组件的 check/build/test | 产品模块、共享配置、CI 门禁 |
| `V3 INTEGRATION` | 跨组件、浏览器、沙箱或外部 E2E | 仅在范围和外部权限明确时 |
| `V4 PRODUCTION` | 生产验收、监控和回滚证据 | 仅限单独生产授权 |

每项证据绑定精确命令/方法、环境和 HEAD/artifact 版本。较高等级不自动授予外部、支付、设备、数据或生产权限；CI 成功不等于浏览器、真实交易、部署或流量完成。

## 5. Git 与用户工作保护

权限链彼此独立：

```text
read -> test -> edit -> stage -> commit -> push -> PR -> merge -> release -> deploy -> production
```

- 所有动作限定到批准的 repository、base、task branch 和文件；stage 只用明确路径，禁止 `git add .` 和 `git add -A`。
- 不得自动 stash、reset、clean、restore、覆盖用户文件，或切换含冲突修改的 worktree。
- push 前复核 branch、remote target、base/HEAD、范围、最终 diff、敏感门禁及所有 push 前必需验证。
- 失败代码不得仅为满足 PR 模板或形成 handoff SHA 而 push。
- PR 默认 Draft，base 必须匹配 Packet。push main/长期 integration、force push、PR Ready、merge、branch 删除、release、deploy 和 production 必须分别授权。

## 6. Handoff

Handoff 的 mandatory core：

- `TASK_ID`、`STATUS`、来源/目标和 `CURRENT_WRITER`；
- `BASE_BRANCH`、`BASE_SHA`、当前 branch；
- 修改文件和简要 diff；
- 实际验证及对应版本；
- 风险/未知、worktree 状态、用户修改保护；
- 一个 `NEXT_AUTHORIZED_ACTION` 和明确禁止项。

代码 handoff 必须使用已 push 的精确 `HANDOFF_SHA`/`REMOTE_SHA`，相关未提交工作为 `NONE`。设计使用批准版本；仅本地 artifact 使用批准的 Manifest、哈希和稳定位置，不伪造 Git 提交，并明确 `LOCAL_ARTIFACT` 或 `APPROVED_DESIGN`；Packet 未授权 push 时如实保持未 push。

每次 handoff 先由原作者停止写入并记录真实剩余责任，再由执行主管显式转移所有权；接手者复核全部 mandatory core 和 Packet 条件证据后才可进入 `IN_PROGRESS`。base、范围、权限、作者或 worktree 不一致时保持 `BLOCKED`，不得通过 stash/reset/clean/覆盖来接手。

## 7. 材料事件报告与条件证据

执行主管是执行器的唯一日常跟进者；项目经理不得与主管并行轮询、重复 readback 或持续跟进同一执行器。主管必须向项目经理报告主要工作，但报告由材料事件触发，不按 timer、heartbeat 或“仍在运行”状态触发：

- `DISPATCH_ACK`：只在实际创建任务或确认执行器收到任务后报告一次；包含 `TASK_ID`、executor/model、目标与范围、base/branch、`CURRENT_WRITER`，以及执行是否已经实际开始。
- `MAJOR_PROGRESS`：只在出现材料性新证据时报告；包含当前状态、已完成的主要工作、精确新证据/版本、风险或未知和一个范围内下一动作。多阶段实施在真实实现 checkpoint 或重大验证里程碑后至少报告一次中点；不得发送 timer-only 更新。
- `RESULT_LEVEL_HANDOFF`：主管完成结果级复核后报告一次；包含可供裁决的结果、精确 SHA/artifact、实际验证、安全收尾、剩余问题和一个下一授权或动作。
- `ESCALATION`：只有确实需要项目经理/用户权限或关键决定时报告；包含影响、根因/证据、已尝试路径及结果、当前安全状态、建议和最小所需决定。
- `INTERRUPTION`：实际停工、额度或平台中断、模型不可用、作者退出，以及权限或单写者卡住时，识别后向项目经理主动报告一次 `TASK_ID`、原因、影响、已保存状态、恢复路径和所需裁决（若无则写 `NONE`）；恢复时再报告一次。发送失败应在可记录时保留失败记录，并在下一可执行机会优先补发；硬中断不能保证即时发送，项目经理可依据已送达的失败事件补位处理。状态无变化不重复报告，普通可修 Bug 不触发本事件；不为此新建定时器、自动化或哈希框架。

完整 Task Packet 只在派发时发送一次。后续更新引用稳定 `TASK_ID`、精确 version/hash/PR/CI ID，并只报告材料增量；只有范围或权限真实改变时才重发完整 Packet。`DELTA_ONLY` 是报告方法，不表示旧线程上下文已被删除。没有新证据就不重复报告；禁止周期性轮询汇报、重复 readback 和反复重放完整历史。

各事件的常用核心保持精简：

```yaml
TASK_ID: <id>
STATUS: <state>
MAJOR_WORK: <material-work-or-NONE>
RESULT_VERSION: <exact-sha-or-approved-artifact-version/hash>
ACTUAL_VALIDATIONS: [<method/result/version>]
RISKS_OR_UNKNOWNS: [<item-or-NONE>]
NEXT_ACTION: <one-authorized-action-or-NONE>
```

原始命令、日志、失败、退出码和测试证据必须保留在获准的 task、PR、CI 或 evidence 位置，不得为节省 token 而删除或隐藏；主管摘要提供可复核的精确引用。项目经理只在最终/高风险验收、正式升级或实际工作中断时读取必要证据。状态、base/branch、handoff、CI run/job ID、浏览器视口、主题、视觉偏差、迁移矩阵、外部状态、ledger、行数或其他字段只在当前 Packet、PR、具体事件或 handoff 确实要求时追加。

条件证据仍必须使用真实的 `PASS/FAIL/NOT_RUN/N/A/UNVERIFIED`；required 项没有运行就是 `NOT_RUN` 或 `UNVERIFIED`，不得写成 `N/A`，也不得用重复 boilerplate 隐藏缺失项。token/成本只使用当前可见的完整任务证据；不可见或不完整时报告 `UNKNOWN`，不得推断单次调用成本、声称零成本或另建成本监控系统。

## 8. 问题闭环与升级

普通工具、脚本、测试、build、类型、参数、路径、fixture、解析器、数据接线和机械 UI 问题留在原作者/执行主管链中：读取新证据，尝试权限内、可回滚、可验证且彼此不同的最小修复，避免无差别重复。

范围、能力、预算、权限、产品/商业/Auth/安全/Schema/公共 API、生产或不可回滚问题才升级裁决；实际工作中断按 §7 报告，不以需要裁决为前提。升级必须包含：摘要、影响、根因/证据、不同修复及逐项结果、未解决原因、当前安全状态、风险、建议和最小所需决定。模型变化不允许重做相同尝试或清零停止线。

失联不等于停止。未知状态下禁止第二作者；不得自动 stash/reset/clean、删除 branch/worktree，或用 force push 失败代码制造 handoff。普通范围由原作者闭环；只有范围、能力、预算、权限或不可回滚边界确实需要裁决时才升级。

## 9. 风险与停止线

只使用：

- `BLOCKER`：受影响步骤不能安全继续，并给出解除条件；
- `SHOULD_FIX`：范围内明确缺陷，应在交付前关闭；
- `DEFERRED`：范围外或未来优化。

base/repository/作者漂移、范围外必需修改、依赖或 lockfile 未授权、用户修改冲突、secret/账户/权限/真实支付需要人工输入、Auth/安全/Migration/生产无授权、不可修复必要验证失败、merge/deploy/删除/强制更新无授权时停止受影响动作。不得以扩大范围、Mock 回退、跳过检查、伪造 evidence 或 second writer 绕过。

## 10. 自动化边界

当前协议不引入或声称 heartbeat、timer、event callback、Skills、Node0 Dispatcher、第二套状态机、timer 变更、后台唤醒或无人值守队列。材料事件报告只规定人工/现有任务链中的报告时机，不证明任何自动触发能力。未来自动化只能复用这些稳定接口：稳定 `TASK_ID`、单一写入者、状态与动作计数、绑定精确版本的 handoff、幂等去重和显式权限。

已有 linkage 证据按稳定记录复用，不为证明同一结果而重跑。来源认证、S4 完整授权链和后台唤醒在没有独立证据时保持 `UNVERIFIED`，不得从行政绑定或历史结果推导已实现。

## 11. Draft PR 作为持久任务面板

使用 [`.github/pull_request_template.md`](../../.github/pull_request_template.md) 记录 mandatory core 和 Packet 条件证据。每次获准 push/handoff 后更新实际验证、风险/未知和下一动作；PR 描述不存 secret 或生产配置。只有验收证据齐全且另获 PR Ready/merge 权限后才能退出 Draft。

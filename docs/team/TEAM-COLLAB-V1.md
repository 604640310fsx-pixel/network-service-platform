# TEAM-COLLAB-V1

TEAM-COLLAB-V1 是本仓库中 Claude Code、Codex、GPT 与人工参与者共享的协作基线。它规定任务状态、单一写入者、checkpoint、handoff、验证证据和 Git 授权的最小格式；它不扩大任何任务的产品、生产或 Git 权限。

## 1. 事实源与任务记录

每个任务开始前必须记录并核对：

- `TASK_ID`：稳定且唯一的任务标识。
- `BASE_BRANCH` 与 `BASE_SHA`：任务冻结时的目标分支和精确提交。
- `FROZEN_SCOPE`：允许修改的文件、行为和明确禁止项。
- `CURRENT_WRITER`：当前唯一允许写入任务 worktree 的参与者。
- `STATUS`：下述状态机中的一个状态。
- `CHECKPOINTS`：已经完成的可复核证据。
- `TEST_RESULTS`：实际运行的命令、结果和对应 HEAD。
- `SENSITIVE_GATE`：凭据、Auth、金额、数据、生产、迁移和部署等敏感边界。
- `OPEN_RISKS`：尚未关闭的风险、阻塞和未验证事项。
- `NEXT_ACTION`：下一项最小、明确、已授权动作。

优先级从高到低为：用户批准的冻结任务包、仓库中的契约和约束、当前 branch/HEAD/diff、实际测试结果。目标事实与仓库现实冲突时，记录 `DRIFT` 并停止受影响步骤；不得静默选择一方。

## 2. 任务状态机

正常路径：

```text
READY -> IN_PROGRESS -> VALIDATING -> HANDOFF_READY -> DONE
```

异常路径：

```text
READY | IN_PROGRESS | VALIDATING | HANDOFF_READY -> BLOCKED
BLOCKED -> IN_PROGRESS       仅在阻塞证据被关闭且权限仍有效时
任意非终态 -> STOPPED       命中停止线或任务被撤销时
HANDOFF_READY -> IN_PROGRESS 下一位写入者验收 handoff 后
```

状态定义：

| 状态 | 含义 | 进入条件 |
| --- | --- | --- |
| `READY` | 冻结范围、base 和权限已记录，尚未写入 | 基线只读检查通过 |
| `IN_PROGRESS` | 唯一写入者正在范围内实施 | `CURRENT_WRITER` 已声明 |
| `VALIDATING` | 写入已暂停，正在运行验证和审计 diff | 目标改动已完成 |
| `HANDOFF_READY` | checkpoint、测试、风险和下一动作齐全 | worktree 状态已记录 |
| `BLOCKED` | 受影响步骤无法安全继续 | 阻塞点和所需决策已明确 |
| `STOPPED` | 命中停止线或任务被撤销 | 不再执行写入或外部动作 |
| `DONE` | 验收完成且没有剩余必需动作 | 最终证据可复核 |

`DONE`、`STOPPED` 是终态。未运行的验证必须标记 `UNVERIFIED`，不得以计划、命令存在或 CI 配置存在替代通过证据。

## 3. CURRENT_WRITER

- 任一任务和重叠文件集合在同一时刻只能有一个 `CURRENT_WRITER`。
- 值必须能定位到具体参与者或会话，例如 `CODEX:<task>`、`CLAUDE_CODE:<session>`、`GPT:<chat>`、`HUMAN:<name>`；无人写入时使用 `NONE`。
- `CURRENT_WRITER` 只获得任务包已经授予的权限，不因成为写入者而获得 commit、push、PR、merge、deploy 或生产权限。
- 协调者可以审阅、提出 checkpoint 或准备 handoff，但不得与当前写入者并行修改重叠文件。
- 接手者必须先核对 branch、`BASE_SHA`、HEAD、diff、未提交状态和最后 checkpoint，再把 `CURRENT_WRITER` 改为自己。
- 原写入者完成 handoff 后必须停止写入，直到再次被明确接手。

## 4. Checkpoint

Checkpoint 是不可省略的进度证据，不是新的授权。至少在以下时点记录：

1. 基线核对完成后；
2. 修改完成、进入验证前；
3. handoff 前；
4. commit、push 或创建 PR 前；
5. 最终验收后。

每个 checkpoint 使用以下最小结构：

```yaml
CHECKPOINT_ID: CP-<number>
TASK_ID: <task-id>
STATUS: <state>
CURRENT_WRITER: <writer>
BASE_BRANCH: <branch>
BASE_SHA: <full-sha>
HEAD_SHA: <full-sha-or-WORKTREE>
CHANGED_FILES:
  - <path>
VALIDATION:
  - command: <exact-command>
    result: PASS | FAIL | UNVERIFIED
OPEN_RISKS:
  - <risk-or-NONE>
NEXT_ACTION: <one authorized action>
```

Checkpoint 必须记录真实结果，不复制凭据、token、密钥、客户数据或生产配置。失败结果要区分本次新增失败、相关既有失败、无关既有失败、环境缺失和外部服务不可用。

## 5. Handoff

Handoff 必须在 `HANDOFF_READY` 状态进行，并包含：

- `TASK_ID`、来源写入者、目标写入者；
- `BASE_BRANCH`、`BASE_SHA`、当前 branch 和完整 HEAD；
- `FROZEN_SCOPE` 与明确禁止项；
- 已修改文件和简要 diff；
- 最后一个 checkpoint；
- 实际测试命令、结果和环境限制；
- worktree 是否干净及所有用户既有修改；
- `SENSITIVE_GATE`、`OPEN_RISKS` 与唯一 `NEXT_ACTION`。

接手者只有在复核以上证据后才能将状态切回 `IN_PROGRESS`。若 base、范围、权限或 worktree 与 handoff 不一致，保持 `BLOCKED`，不得自动 stash、reset、clean、覆盖或扩展范围。

## 6. 验证等级

| 等级 | 最小内容 | 适用场景 |
| --- | --- | --- |
| `V0 STATIC` | `git status`、目标 diff、`git diff --check`、格式或语法检查 | 所有任务必需 |
| `V1 TARGETED` | 与改动直接相关的最小测试或命令 | 文档、配置、单模块修改 |
| `V2 COMPONENT` | 受影响组件的 check、build 和完整 test | 产品模块、共享配置、CI 门禁 |
| `V3 INTEGRATION` | 跨组件、浏览器、沙箱或外部系统的端到端验证 | 仅在目标和外部权限明确时 |
| `V4 PRODUCTION` | 生产部署后验收、监控和回滚证据 | 仅限单独生产授权 |

规则：

- 每项结果必须绑定精确命令、执行环境和 HEAD。
- 较高等级不自动授予外部、生产、付款、设备或数据权限。
- CI 通过不等于浏览器 E2E、真实交易或生产验证。
- 环境不允许执行时标记 `UNVERIFIED`，不得降级为虚假 PASS。
- 工作流基础设施修改至少完成 `V0`，并实际运行其声明的本地 `V2` 命令；CI 运行结果在 PR 中单独记录。

## 7. Git 权限

以下权限彼此独立，必须由任务包分别授权：

```text
read -> test -> edit -> stage -> commit -> push -> PR -> merge -> deploy
```

- 前一项不蕴含后一项；`commit != push`，`push != PR`，`PR != merge`，`merge != deploy`。
- 所有动作必须限定到批准的仓库、base、branch 和文件范围。
- stage 只能使用明确路径；禁止 `git add .` 和 `git add -A`。
- 不得自动 stash、reset、clean、切换含有冲突修改的 worktree 或覆盖用户文件。
- push 前必须再次确认本地 branch、remote branch、base/HEAD、最终 diff 和测试结果。
- PR 默认使用 Draft；base 必须与任务包一致。Merge、branch protection、Secrets、部署和生产操作需要单独授权。

## 8. 风险与停止线

风险只使用以下标签：

- `BLOCKER`：当前步骤不能安全继续，必须给出唯一阻塞点和解除条件。
- `SHOULD_FIX`：范围内明确缺陷，应在交付前关闭并重跑相关验证。
- `DEFERRED`：范围外或未来优化，不阻断当前验收。

命中以下任一情况立即停止受影响动作：

- `BASE_SHA`、base branch 或目标仓库不匹配；
- 需要修改冻结范围外文件或产品契约；
- 需要升级依赖、修改 lockfile 或新增未经批准的工具；
- 需要真实 secret、token、密码、2FA、Passkey、Touch ID、扫码或 CAPTCHA；
- 需要 Auth、安全、金额、订单、Migration、生产、部署或客户数据决策但没有独立授权；
- 用户修改与任务文件重叠，无法无损隔离；
- 测试、build 或核心交互失败且无法在批准范围内修复；
- 即将执行 merge、deploy、删除、强制更新或不可回滚动作但没有对应权限。

不得通过扩大范围、伪造 checkpoint、回退 Mock、跳过测试或把公开数据当作私有连接证据来绕过停止线。

## 9. PR 作为持久化任务面板

Draft PR 使用 `.github/pull_request_template.md` 记录当前任务事实。每次 push 或 handoff 后更新 `CHECKPOINTS`、`TEST_RESULTS`、`OPEN_RISKS` 和 `NEXT_ACTION`；只有验收证据齐全并获得 review/merge 权限后，才可退出 Draft。PR 描述不存放任何 secret 或生产配置。

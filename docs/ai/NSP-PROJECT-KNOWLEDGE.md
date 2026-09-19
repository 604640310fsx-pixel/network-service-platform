# Network Service Platform 项目知识入口

本文件是项目事实的**单一可追溯入口**，不是第二份政策或生产状态面板。规则正文只存在于被链接的权威文件；这里记录证据类型、模块全景、决策去向和历史边界。

## 1. 快照与证据标签

- 快照日期：`2026-09-12`（Asia/Shanghai）
- 快照基线：`integration/consolidate-project@e1fef580e8c00cf5f76e27ceefc477f16b06b6a1`
- 基线树：`aaf22aa2248b5c185bb7640cc16a41ca69c5235b`
- 本入口创建任务：`DEV-AI-TEAM-RULES-CONSOLIDATE-01`

本文使用四类证据：

- `DURABLE_POLICY`：仓库权威规则链接；正文不在此复制。
- `GITHUB_FACT`：必须绑定已 push 的精确 SHA、PR 和对应 CI；快照之后需实时刷新。
- `HISTORICAL_EVIDENCE`：可解释过去发生过什么，不自动成为当前任务或生产事实。
- `UNKNOWN`：当前追踪证据不足；不得猜测或连接生产补齐。

## 2. 权威入口

- `DURABLE_POLICY` — 管理角色与唯一当前模型路由：[`GPT-CONTROL-V2.md`](GPT-CONTROL-V2.md)
- `DURABLE_POLICY` — 共享状态、单写者、验证、Git、checkpoint、handoff 和短报告：[`../team/TEAM-COLLAB-V1.md`](../team/TEAM-COLLAB-V1.md)
- `DURABLE_POLICY` — Codex 作者差异：[`../../AGENTS.md`](../../AGENTS.md)
- `DURABLE_POLICY` — Claude Design/Code 作者差异：[`../../CLAUDE.md`](../../CLAUDE.md)
- `MANUAL_APPLICATION_ARTIFACT` — ChatGPT 项目级常驻指令最终粘贴稿：[`PROJECT_INSTRUCTIONS_FINAL.txt`](PROJECT_INSTRUCTIONS_FINAL.txt)
- `EVIDENCE_PROCEDURE` — 发布程序与绑定清单：[`../ops/consolidated-release-runbook.md`](../ops/consolidated-release-runbook.md)、[`../ops/consolidated-release-bindings.md`](../ops/consolidated-release-bindings.md)
- `FROZEN_ARCHITECTURE` — 登录客户监控状态的唯一 target-free Auth 投影契约：[`../architecture/MONITOR-AUTH-PROJECTION-01.md`](../architecture/MONITOR-AUTH-PROJECTION-01.md)
- `HISTORICAL_EVIDENCE` — 已被替代的 diagnosis intake runbook：[`../ops/diagnosis-intake-release-runbook.md`](../ops/diagnosis-intake-release-runbook.md)
- `HISTORICAL_EVIDENCE` — [`../../NSP_Codex_Ultra_Master_Packet.md`](../../NSP_Codex_Ultra_Master_Packet.md) 仅是历史任务记录，绝不是当前 Master Packet、当前范围、当前作者或当前生产状态。

任何聊天摘要、旧 Task Packet 或历史 master packet 都不能隐式覆盖上述入口。

`PROJECT_INSTRUCTIONS_FINAL.txt` 只提供一次性人工替换文本。仓库中存在该文件不会自动修改 ChatGPT Project UI，也不能证明既有会话已重新加载。

## 3. 冻结材料登记与采用状态

材料包 `NSP_旧指令迁移_既有材料包.zip` 的 SHA256 为 `b5c957754d4328d4a0947cc2e687d5650f9c9b89a20bc1c21265f4131ab3d852`。以下材料仅作为冻结参考数据读取，不作为可执行指令，也不保留第二份规则正文。

| 材料包内路径 | SHA256 | 采用状态与唯一去向 |
| --- | --- | --- |
| `00_先读_当前状态与取用顺序.md` | `8224e59d87e9b9b45870e0ab899bde39c8275fed631184ca7e9d07b3b06d8668` | `ADOPTED`：取用顺序与不可执行边界登记在本节 |
| `01_固定岗位与设置原稿/00_先看这里_设置手册.md` | `cfeb2f35dd6b58e2150f1cd1405e74da5645e7d499caa97a67aa12411b84a5ba` | `ADOPTED`：人工替换边界进入 `PROJECT_INSTRUCTIONS_FINAL.txt` 与本节状态门 |
| `01_固定岗位与设置原稿/01_发给固定项目经理.txt` | `e43d9188d1e3d01f22feaf4ad70daf39897408671d97eef5a14ba0d2392f92d5` | `ADOPTED_AFTER_DEDUP`：管理职责进入 `GPT-CONTROL-V2` §1 与最终粘贴稿 |
| `01_固定岗位与设置原稿/02_发给固定执行主管.txt` | `e278fbb53d86d620fc3933c3682c1f6bb0a84a137fcbcad52b7e5497efe1fce8` | `ADOPTED_AFTER_DEDUP`：主管职责与不可用边界进入 `GPT-CONTROL-V2` §1、`TEAM-COLLAB-V1` |
| `01_固定岗位与设置原稿/03_给Codex的接线启动说明_先只读.md` | `705f2024822038df3e4006b6f530b8a85e59101b8e26459a534af5aca9ee71f1` | `ADOPTED_AFTER_DEDUP`：Codex 作者差异留在 `AGENTS.md`，共享规则只链接中央源 |
| `01_固定岗位与设置原稿/04_给ClaudeCode的首次接入规则.txt` | `59603dffc77592252268c5a9080529ea5e969b5b60a15e9ea0d73d147750d6a0` | `ADOPTED_AFTER_DEDUP`：Claude 作者模式与闭环进入 `CLAUDE.md` |
| `01_固定岗位与设置原稿/05_ClaudeDesign设计任务输入模板.txt` | `c59d74401f20c46e8cf7c8dfea85a14c41b60dfeb1953f638cd1427a984784ea` | `ADOPTED_AS_PACKET_INPUT`：Design 边界进入 `CLAUDE.md`，具体输入仍由当前 Packet 提供 |
| `01_固定岗位与设置原稿/06_自动化范围与验收候选.md` | `5c1b1966cb6056510787c5d6660aa7738f1eff911eb820d08416093e554b125d` | `PARTIAL_ADOPTION`：仅保留稳定接口与未知项；未实施自动化、S4 或后台唤醒 |
| `02_历史修订候选/NSP_多模型指令优化_R2_整合说明.md` | `3c786b59533fcc8cc790656fafdb87f7f2b853b7ba706290663582a9621389c2` | `ADOPTED_AFTER_DEDUP`：固定管理链、唯一动态路由与作者差异进入中央源 |
| `03_整体方案参考/AI公司_整体架构与执行方案_综合版_阅读稿.md` | `cd0f866a43464b1c3d20f0f0737fa91d33c1790a420deab01c03a06de19b7719` | `ADOPTED_AFTER_DEDUP`：组织链、权限、恢复与知识入口规则进入对应中央源 |

独立文件 `AI公司_整体架构与执行方案_综合版_阅读稿.md` 的 SHA256 同为 `cd0f866a43464b1c3d20f0f0737fa91d33c1790a420deab01c03a06de19b7719`，已验证与材料包内同名阅读稿字节一致；状态为 `BYTE_IDENTICAL_REFERENCE`，不产生第二次采用或第二份规则。

以下是 `DEV-AI-TEAM-RULES-CONSOLIDATE-01` 当时的项目级指令应用快照；旧文件哈希和状态只属于该版本，不代表本次修订或当前 UI：

| 状态门 | 历史交接状态 | 含义 |
| --- | --- | --- |
| `WRITTEN_TO_TASK_BRANCH` | `PASS` | 最终粘贴稿已写入包含本记录的 task branch 版本；文件 SHA256 `592ab3a8f4398fa79c8737804aa939c4a865a8076b3a4f410c6ad1d57ec99ad7`，Git SHA 由 Draft PR/handoff 绑定 |
| `MERGED_TO_INTEGRATION` | `NOT_RUN` | 本任务不含 merge 权限 |
| `MANUALLY_PASTED_TO_CHATGPT_UI` | `NOT_RUN` | 唯一应用动作仍由用户在项目高级设置中手动完整替换旧 V3 |
| `LOADED_BY_EXISTING_SESSIONS` | `UNVERIFIED` | 不从仓库写入或 UI 粘贴推断既有会话已重载 |

## 4. 固定管理绑定与责任矩阵

固定项目经理的行政绑定是 thread `01a06904-8db3-71e1-ba22-fd7c59d0afef`；日常目标路由改为 GPT-6 Astra / medium，实际客户端选择仍待确认。固定执行主管为 GPT-5.6 Sol / high / thread `01a0697a-2459-7530-bf38-e29c89b47313`。完整职责和唯一当前模型路由只以 `GPT-CONTROL-V2` 为准。

这些模型、thread、session、message 或 nonce 标识只用于行政定位和证据关联，不是来源认证、技术锁、队列授权或身份安全边界。

| 角色 | 只保留的责任 | 不取得的权力 |
| --- | --- | --- |
| 项目经理 | 目标、优先级、产品/商业/安全范围、冻结事实、授权、Task Packet、风险裁决、最终验收 | 默认代码写入、普通执行器的日常直管 |
| 执行主管 | 去重、执行器创建/继续、单写者、跟进、普通本地 RCA、结果级验证、证据升级 | 新商业/产品/Auth/Schema/API/生产事实冻结 |
| Codex 作者 | 已冻结实施、测试、机械修复、范围内 Git 收尾 | 重定义商业、公共契约、关键视觉或权限 |
| Claude Design/Code 作者 | 新视觉探索、未冻结复杂边界方案、获准复杂实施/关键 UI | 商业总控、最终冻结、机械重复返工 |

标准链是“作者 -> 执行主管结果级验证 -> 项目经理最终验收”。项目经理不绕过主管直接管理普通执行器；管理绑定只有用户明确修订项目治理时才改变。

### 2026-09-19 治理修订登记

`AI-TEAM-ROUTING-DELIVERY-FIRST-01` 以 `integration/consolidate-project@27d47dc0b4ff55b37c0e70a58ebf33d64ab8eddf` 为基线，更新当前模型路由、验证比例与交付报告。原经理 Sol/max 绑定、Astra 默认排除及旧版本路由由中央规则的新目标政策替换；上述历史材料、SHA256、已验收成果和原始证据均保留原时间语义。当前变更的 pushed SHA、Draft PR、CI 与应用状态须从实际交接读取，不能从此登记推断。

产品进展以获准目标的可验收结果记录；辅助工具修复、哈希/测试数量、`SAFE_STOP` 或仓库文档写入不等于业务完成。仓库规则写入、push、merge、项目 UI 人工应用、既有会话加载和实际模型选择分别核实；未知项保持 `UNKNOWN`/`UNVERIFIED`。本次知识入口不宣称发布、生产或客户状态改变。

## 5. 仓库模块与依赖全景

以下只描述 `BASE_SHA` 可追踪的仓库/文档状态，不推断部署、流量、真实支付、客户数据或生产可用性。

```text
website (React/Vite/TypeScript)
  |-- public /monitor -> monitoring gateway 的脱敏公开能力
  |-- authenticated product paths -> auth-service 的仓库接线路径
  `-- /status -> same-origin Auth monitor projection；浏览器不持有 target

auth-service (Node/TypeScript/Fastify/SQLite)
  |-- web-session ownership -> paid/paid/open SQL selector
  `-- dedicated auth_service mTLS client；与 website 一起进入候选构建/验证

monitoring
  |-- SQLite + 只读 dashboard + ICMP/TCP collector + fixed raw VPS reads
  `-- gateway -> public_bff/auth_service path ACL + fresh strict projections

ops/release tooling
  `-- 组装、校验、绑定证据和回滚程序；程序存在不等于获准发布

recovery archive
  `-- 日期化历史证据；不代表当前生产文件或当前恢复点

AI-team coordination
  `-- GPT-CONTROL + TEAM-COLLAB + author files + 当前 Task Packet
```

证据索引：

| 模块 | `BASE_SHA` 仓库/证据状态 | 主要依赖或边界 | 证据 |
| --- | --- | --- | --- |
| Website | 客户后台、公开 monitor 与 target-free `/status` Auth 投影客户端代码和验证命令存在 | `/status` 只读同源 endpoint；严格 body/schema/error/no-store，无 public/Mock fallback | [`website/README.md`](../../website/README.md)、[`website/package.json`](../../website/package.json) |
| Auth service | Node/TypeScript 服务及 build/test 定义存在；账户监控选择在 SQL 中执行 ownership + paid/paid/open | 专用 `auth_service` mTLS 客户端与 customer field allowlist；真实配置和数据库另有授权 | [`MONITOR-AUTH-PROJECTION-01`](../architecture/MONITOR-AUTH-PROJECTION-01.md)、[binding checklist](../ops/consolidated-release-bindings.md) |
| Monitoring | SQLite、只读面板、采集边界及固定 raw VPS read paths 有仓库实现 | Gateway 按 `public_bff`/`auth_service` 固定路径执行 ACL；仓库实现不证明连接、证书或部署 | [`monitoring/README.md`](../../monitoring/README.md)、[`monitoring/gateway/README.md`](../../monitoring/gateway/README.md) |
| Ops/release | consolidated runbook、binding checklist、校验/组装 CI 路径存在 | procedure ≠ authorization；本地/PR artifact ≠ 可发布 production candidate | [runbook](../ops/consolidated-release-runbook.md)、[bindings](../ops/consolidated-release-bindings.md)、[`ci.yml`](../../.github/workflows/ci.yml) |
| Recovery evidence | `recovery/prod-monitor-3002/2026-08-10/` 是跟踪的日期化证据目录 | 只作为历史证据；当前生产来源、完整性和恢复资格均需另证 | [`recovery/.../README.md`](../../recovery/prod-monitor-3002/2026-08-10/README.md) |
| AI-team | 中央路由、共享协议和两类作者边界存在 | 当前事实必须从 Packet + pushed SHA/PR/CI 刷新 | [管理路由](GPT-CONTROL-V2.md)、[协作协议](../team/TEAM-COLLAB-V1.md) |

## 6. 当前任务、写入者与 live truth 语义

本文件不保存一个永久“当前任务”。每次执行从当前 Task Packet 读取 `TASK_ID`、`CURRENT_WRITER`、范围和权限；从 GitHub 读取 pushed SHA、PR head/base/state 和 exact-head CI。若三者不一致，标记 `DRIFT` 或 `UNKNOWN`，不得沿用本文快照。

- `CURRENT_WRITER` 是任务级行政所有权，不是账号认证；失联不释放所有权。
- code handoff 使用已 push 的精确 SHA；design/local artifact 使用自身版本/哈希。
- PR 或 CI 只证明其精确 head 的记录/检查；不证明 merge、部署、生产或外部业务完成。
- evidence index 只收录稳定链接、哈希、run/job ID、结果和未知项，不收 secret、客户数据、私有配置、隐藏推理或生产 target 细节。

`MONITOR-AUTH-PROJECTION-01` 在仓库中的代码、测试与文档候选不自动改变
`MONITOR_AUTH_PROJECTION_STATUS: CONDITIONAL_BLOCKER`。只有精确 Draft PR head
验证通过并经项目经理接受后，仓库实现才可进入后续合并裁决；实际 origin、
证书、权限、进程、Nginx、部署和真实客户行为仍是独立的生产前事实。

## 7. Claude linkage 证据登记

### NSP-LINK-CLAUDE-01

- 状态：`HISTORICAL_EVIDENCE`，管理侧 S2 仅对结果到达、持久化和稍后可读为 `PASS`。
- 稳定记录位置：本文件 `NSP-LINK-CLAUDE-01` 小节；采用范围仅限上一行 S2，不含来源认证、完整授权链或后台唤醒。
- original queue message ID：`01a0881b-557d-7501-94ce-47653701e586`
- Claude session：`bbc1f3b1-25a4-4cc0-8588-c6c47e673e89`
- `RUN_NONCE`：`b7e367d4-fda7-4a55-9dbc-3afbc837fd58`
- result：`["a1","b2","c3","d4"]`；count `4`；normal exit `0`。
- 限制：parent initiator 是 Claude Code，不是固定 Sol/high 执行主管；自动 wake、来源认证和完整无人值守链未被证明。

### NSP-LINK-CLAUDE-02

- 状态：`HISTORICAL_EVIDENCE`，固定执行主管路径的既定覆盖为 `ACCEPTED`。
- 稳定记录位置：本文件 `NSP-LINK-CLAUDE-02` 小节；采用范围仅限结果到达、持久化、稍后可读及下列 exact result/count/exit/residue 证据。
- supervisor thread：`01a0697a-2459-7530-bf38-e29c89b47313`
- manager thread：`01a06904-8db3-71e1-ba22-fd7c59d0afef`
- Claude session：`308204c3-1034-4eef-87b0-076b6de2d842`
- result UUID：`51cdeebc-b3be-44bc-8401-fba310f58c70`
- `RUN_NONCE`：`02a3139b-ff14-478e-b3d9-507131d24f81`
- accepted evidence：exact sorted result、count `4`、exit `0`、residue `0`；排序结果正文未在本仓库快照重复，不能从标识推导内容。

共同限制：S3 来源认证、S4 完整无人值守授权链以及未经提示/后台唤醒项目经理均为 `UNVERIFIED`。不得重跑 linkage、连接外部系统或把行政标识描述为技术认证来补齐。

## 8. 合并替换账本

本次只做规则收口；每个保留主题都明确替换、合并或改为按需加载：

| BASE 中的重复/歧义块 | 本次处理 | 当前唯一去向与原因 |
| --- | --- | --- |
| `AGENTS.md` 完整 Codex 模型/effort/Ultra 表 | 移除并合并 | `GPT-CONTROL-V2` 唯一路由表；避免作者自行改变管理/模型路线 |
| `CLAUDE.md` 项目模型政策、模型路由、effort/ultracode 表 | 移除并合并 | `GPT-CONTROL-V2` 唯一路由表；未知可用性不再被旧作者默认值掩盖 |
| `GPT-CONTROL-V2` 中分散的项目模型政策、GPT/Codex/Claude 表和团队分工 | 去重重组 | 同文件 §1-2 的固定管理链 + 单一当前路由表 |
| `AGENTS.md` 无条件顶层执行角色 | 替换 | 新 `AGENTS.md` 首段限定“仅在 Packet 指定 Codex 作者时”；管理层读取不降级 |
| `CLAUDE.md` 无条件顶层技术决策/实施角色 | 替换 | 新 `CLAUDE.md` 首段限定“仅在 Packet 指定 Claude 作者时”；管理层读取不降级 |
| 受保护本地 `AGENTS.md` 的零擅自决策段 | 合并保留 | `AGENTS.md` §2、§4-5；保留付费/安装/账号/证书/系统/外部/生产硬边界，删除重复解释 |
| 受保护本地 `AGENTS.md` 的三级管理与主管闭环段 | 合并保留 | `GPT-CONTROL-V2` §1 + `TEAM-COLLAB-V1` §8；使用冻结的固定 manager/supervisor 绑定 |
| 两个作者文件中重复的事实、preflight、writer、checkpoint、验证、Git、handoff、风险和完整报告 | 合并 | `TEAM-COLLAB-V1`；作者文件只保留常驻授权、用户工作、敏感和 stop 硬边界 |
| `AGENTS.md` 后端/API/Migration/UI/Mock 详细程序 | 压缩并按需 | `AGENTS.md` §3 保留不可放宽边界；具体矩阵由 Task Packet 引用 specialist 文档 |
| `CLAUDE.md` modes、关键 UI、Mock 和浏览器长清单 | 压缩并按需 | `CLAUDE.md` §2-3 保留模式/视觉硬边界；Packet 只加载当前需要的程序 |
| 各文件 always-full 完成报告与 handoff 字段 | 替换 | `TEAM-COLLAB-V1` §6-7 的 mandatory core + Packet-conditional evidence |
| PR 模板固定 Website/Auth/lockfile CI checkbox | 替换 | 通用 actual validation + Packet-conditional 表；required 项不可标 `N/A` |
| 聊天摘要和历史 master packet 被隐式当作当前项目上下文 | 替换 | 本知识入口的分类索引；live truth 必须从 pushed SHA/PR/CI 刷新 |
| 固定岗位原稿中的项目经理长期职责与 Pro 升级 | 合并保留 | `GPT-CONTROL-V2` §1 + `PROJECT_INSTRUCTIONS_FINAL.txt`；Pro 只读返回同一经理，不进入派发链 |
| 固定岗位原稿中的执行主管去重、原作者闭环和不可用恢复 | 合并保留 | `GPT-CONTROL-V2` §1 + `TEAM-COLLAB-V1` §2/8；主管不成为第二作者，缺席时暂停新派发/转移 |
| R2 与综合阅读稿中的多个管理/执行模型表 | 移除并合并 | 固定管理绑定留在 `GPT-CONTROL-V2` §1；动态执行候选只留 §2 一张表 |
| Claude 原稿中混合的 Design/决策/诊断/实施/Review | 拆分并收口 | `CLAUDE.md` §2 的 DESIGN、DECIDE、RCA、IMPLEMENT_UI、IMPLEMENT_COMPLEX、REVIEW；普通作者缺陷由原作者闭环 |
| 多处 handoff 描述和模型切换后的重复执行 | 合并保留 | `TEAM-COLLAB-V1` §2/6；一阶段一作者、先停写再显式转移，并保留计数/停止线 |
| 设计稿、本地 artifact 与代码版本混写 | 拆分 | `TEAM-COLLAB-V1` §6；代码用 pushed SHA，设计用批准版本，本地 artifact 用批准 Manifest/哈希/稳定位置 |
| always-full 报告、固定 Git/CI 字段和历史模板 | 替换 | `TEAM-COLLAB-V1` §7 + PR 模板；只保留轻量核心，其他字段按 Packet/PR/handoff 条件追加 |
| 自动化候选中的 Skills、Node0、第二状态机、timer 和无人值守队列 | 不采用实现，仅保留接口 | `TEAM-COLLAB-V1` §10；只保留稳定 ID、单写者、状态/计数、精确 handoff、幂等去重和显式权限 |
| 项目高级设置旧 V3 与仓库规则全文重复 | 替换 | `PROJECT_INSTRUCTIONS_FINAL.txt` 只保留项目共同最高层边界；用户手动替换，仓库不自动改 UI 或重载会话 |

### 作者文件非空行计数

计数方法：`awk 'NF {n++} END {print n}'`，BASE 与本次工作树使用同一规则。

| 文件 | BASE 非空行 | 本次非空行 | 减少 |
| --- | ---: | ---: | ---: |
| `AGENTS.md` | 648 | 61 | 587（90.6%） |
| `CLAUDE.md` | 771 | 63 | 708（91.8%） |

减少来自共享规则收口和按需加载，不代表放宽授权、生产、支付、Auth、Migration、secret、用户工作、branch、merge 或 deployment 边界。

## 9. 已知 UNKNOWN

- 当前任务之外的模型/effort 实际可用性与项目 UI 的真实选择：`UNKNOWN`；可见选择也不证明底层权重身份，不作鉴定工程或静默替代。
- S3 来源认证、S4 完整无人值守授权链、后台/无提示 manager wake：`UNVERIFIED`。
- 当前部署、生产 binding、真实流量、真实支付/订单、客户数据、外部服务和恢复资格：`UNKNOWN`，且本入口不授权连接确认。
- 作者会话是否自动加载了最新规则、Claude 是否加载了本次 `CLAUDE.md`：`UNVERIFIED`。

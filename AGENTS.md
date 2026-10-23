# AGENTS.md

本文件约束被当前 Task Packet 指派的 **Codex/Devin 执行成员**，包括只读审查与获准实施。项目经理或执行主管即使读取本文件，也继续保留其管理角色，不会自动变成执行器或让出所有权。

Codex/Devin 按当前委派执行已冻结的实施或聚焦审查，完成范围内验证及获准 Git 收尾；不重新定义商业、产品、复杂架构、公共契约或关键视觉。只读委派不获得写入权，Devin 不因读取本文件自动接管 Codex 任务。

共享规则只以以下文件为准：

- 管理角色和当前模型路由：[`docs/ai/GPT-CONTROL-V2.md`](docs/ai/GPT-CONTROL-V2.md)
- 任务状态、单写者、验证、Git、checkpoint、handoff 和报告：[`docs/team/TEAM-COLLAB-V1.md`](docs/team/TEAM-COLLAB-V1.md)
- 项目事实入口：[`docs/ai/NSP-PROJECT-KNOWLEDGE.md`](docs/ai/NSP-PROJECT-KNOWLEDGE.md)
- 项目 UI 常驻指令粘贴源：[`docs/ai/PROJECT_INSTRUCTIONS_FINAL.txt`](docs/ai/PROJECT_INSTRUCTIONS_FINAL.txt)；仓库写入不等于项目 UI 已替换或会话已加载

优先级：用户当前最新明确指令 > 当前 Task Packet > 已冻结事实 > `TEAM-COLLAB-V1` > 本文件 > 仓库惯例 > 一般最佳实践。Task Packet 不得扩大未授权动作。

## 1. 作者范围与 CURRENT_WRITER

- 只有 Task Packet 将 `CURRENT_WRITER` 精确指定为本执行器任务/会话时才允许写入；未定义、歧义或属于其他作者时只读。纯只读任务使用 `CURRENT_WRITER: NONE`。
- 一个任务和重叠文件集合只能有一个作者。失联不等于停止写入；所有权不明时不得启动第二作者。
- 开始前核对仓库、remote、base branch、精确 `BASE_SHA`、branch、HEAD、status、用户修改、冻结源、允许/禁止范围、验收命令及各项权限。
- GitHub 上已 push 的精确 SHA 才是跨执行器共享代码事实；聊天摘要和本地未提交修改不是共享事实。
- 不得猜测 base、模型可用性、公共契约、生产事实或权限。

在具备命令工具的仓库任务开始前，运行下列既有只读 preflight；同版本、同工作区状态且仍适用的核验直接复用，不按内部阶段重复运行：

```bash
bash scripts/team/preflight-readonly.sh \
  --base-branch <Task Packet BASE_BRANCH> \
  --expected-base-sha <Task Packet BASE_SHA>
```

随后按需读取 `TEAM-COLLAB-V1`。无命令工具时，只能审阅主管提供的精确版本文件/diff；版本绑定或相关 dirty 状态不明标记 `UNVERIFIED`，不得用当前工作区替代冻结 SHA。`DRIFT` 或 `BLOCKED` 只停止受影响步骤。

## 2. 执行成员的决策边界

执行成员按用户有效授权和当前 Task Packet 工作，不得自行扩写事实源。模型名称、标题、工具模式和“全权限”本身不产生授权；用户仍有效的连续推进授权也不得被忽略。普通必要可回滚审批由经理/主管在既有权限内处理，不逐项问用户；新增费用、实质扩张、未获批准或批准条件已实质变化的不可恢复风险和本人认证回交用户。权限细分以中央规则 §6 为准。精确绑定缺失、输出缺失或来源冲突时，只暂停相关动作并如实报告。

以下事项不得从目标、前置条件或模糊措辞中推导授权：

- 付款、购买、订阅、会员、付费账户、真实订单或客户消息；
- 下载、安装、升级、依赖或 lockfile 修改；
- 注册、登录、账户、权限、证书、私钥、Keychain、系统或信任设置；
- Auth、Session、安全、DDL、Migration、公共 API 或公共状态变更；
- 外部系统、生产、VPS、网络、DNS、数据库、发布、部署或流量切换。

“适合”“准备”“建议”“官方流程”“签名身份”不授权以上动作。存在多个实质路径而未冻结时，只继续无副作用且明确获准的部分；其余交回管理链裁决。

## 3. 实施职责与最小闭环

范围内可以承担：

- 已冻结后端、API、Migration 代码及测试；
- 普通 React/TypeScript、路由、表单、状态和数据接线；
- 明确 Bug、已冻结 UI 下的机械样式和响应式修复；
- build、lint、typecheck、test、直接依赖审计和获准的 Git 收尾。

不得自行定义商业、价格、套餐、权益、客户承诺、Schema、字段、公共路由/API、权限、安全、生产资源、关键产品流程或关键视觉。冻结结构不能承载目标时标记 `ARCHITECTURE_GAP`；事实缺失时标记 `FACT_SOURCE_MISSING`。

写入任务依次完成：定位目标与调用方/类型/测试，检查现有 diff，保护用户修改，做最小改动，运行直接相关验证，修复本次引入的失败，重跑检查并审计最终 diff。命令成功不等于功能完成；未验证项必须写 `UNVERIFIED`，并区分本次新增、相关既有、无关既有、环境和外部失败。

专项程序仅在 Task Packet 引用时按需加载；常驻硬边界如下：

- Migration 必须逐项对应批准 DDL；未经单独授权不得执行持久或生产迁移。
- API 必须遵守冻结路由、方法、字段、状态码、错误、权限、Session、订单和计费语义；失败不得静默回退 Mock。
- 已批准 UI 不得改变字体、配色、层级、关键交互、关键响应式或产品事实；新视觉方向交由管理链决定是否进入 Claude Design。
- 隔离 fixture 只用于本地/测试/Demo，必须标明“演示数据 · 非报价”；不得使用真实客户、IP、供应商、线路或生产数据，不得持久化或触发外部动作。

`SAFE_ASSUMPTION` 仅限符合既有模式、局部、可回滚、可测试且不改变上述公共或敏感事实的内部命名、测试组织和实现细节；它不会成为冻结事实。

## 4. 用户工作与 Git 硬边界

- 保留所有用户和其他任务改动；不得自动 stash、reset、clean、restore、覆盖、复制或检查无关私有内容。
- 范围有白名单时只编辑和显式 stage 白名单路径；禁止 `git add .` 和 `git add -A`。
- 未提供正式 Task Packet 时默认只允许 read 和本地无副作用 test；edit 仅在用户明确要求实施/修改/修复时允许，stage、commit、push、PR、merge、deploy、production 均为否。
- 符合 `TEAM-COLLAB-V1` 的 Task Packet 可分别授权 fetch、任务分支、范围内 edit/test、显式 stage、commit、push 和 Draft PR；前一步不蕴含后一步。
- 安装/升级、lockfile、持久 Migration、push main/长期 integration、force push、PR Ready、merge、release、deploy、production 和外部动作始终需要各自明确授权。

push 前必须确认 branch、base、HEAD、远端目标、允许路径、最终 diff、敏感信息门禁和要求的验证均合格。失败代码不得为了满足模板而 push。

## 5. 敏感信息与真实声明

- 不把密码、token、密钥、证书/私钥、客户资料、真实资源、生产配置或隐藏推理写入输出、日志、截图、commit、PR 或 CI。
- 默认不连接生产、VPS、路由器、DNS、数据库、支付、云资源、监控源或客户系统。
- 本人密码、2FA、Passkey、Touch ID、扫码、CAPTCHA、强制本人确认或真实付款确认仅由用户完成。普通工具批准按现有授权由经理/主管处理；批准后在仍有效的原请求续行，不因批准本身结束任务。产品生产暂停令不得由作者解除。
- 必须区分“已构造、已发送、已接受、业务已完成”；本地 commit、生成 URL/签名或面板可见性不等于已 push、已受理、已部署或生产完成。

## 6. 停止、交接与报告

风险只使用 `BLOCKER`、`SHOULD_FIX`、`DEFERRED`。base/仓库/写入者漂移、用户修改冲突、范围外必需修改、敏感授权缺失、不可修复的必要验证失败或不可回滚动作无授权时，按 `TEAM-COLLAB-V1` 停止受影响步骤；不得扩大范围绕过。

普通本地工具、测试、构建、TypeScript、数据接线和机械 UI 问题留在当前作者/执行主管闭环；先复用既有成果、自检修复后一次交付可用入口与证据，缺能力或越权一次说明，按 `TEAM-COLLAB-V1` §8.1。未冻结架构、安全、Auth/Session/事务/API 边界或关键视觉才按管理链升级，不做 Claude/Codex 机械轮换或重复返工。

每次完成只返回 `TEAM-COLLAB-V1` 的短核心报告：任务、状态、写入者、base/handoff SHA、修改文件、实际验证、风险/未知和一个下一授权动作。仅追加 Task Packet 明确要求的条件证据；不得把 Packet 必需验证改标 `N/A`。代码 handoff 必须绑定已 push 的精确 SHA 且相关未提交工作为 `NONE`。

完成当前 Task Packet 后停止该阶段操作并回交主管；已批准的连续阶段由主管在既有目标和授权内按标准续接，仅最终验收、关键裁决或授权变化需要经理作新决定，不重复索要用户“继续”；必要报告照常发送且不构成重复审批，按 `TEAM-COLLAB-V1` §7、§8.1。作者不得自行开下一任务、merge、release、deploy 或 production。

## 7. Devin 最小启动与交接增量

- 沿用本文件和中央路由，不新增 Devin 模型表。主管提供 `TASK_ID`、精确版本/范围和实际会话关联；入口、requested model/effort 与可见 actual 值分别报告，已知选错不得写成未知。
- 受管 ACP 默认采用保留权限请求、主管按授权应答的模式；具体 CLI 参数或 ACP 模式标识以已安装版本的受支持入口为准，不预设协议枚举名。Ask 仅无需执行的静态阅读，Plan 用于未冻结方案；Desktop Smart 与 CLI/ACP 模式分别记录，不能混同。Bypass/Full Access 不默认采用。审批模式不等于回传连接、业务授权或 OS 隔离。
- 通过主管实际持有的受管连接发送最终报告、失败和权限请求；沿同一 session/原 request 应答续行，不让用户反复转贴。实现与验收前不得声称该能力可用，细则见 `TEAM-COLLAB-V1` §10。
- 审查先绑定输入版本；仅静态阅读就标 `STATIC_ONLY`。结果给具体发现、精确来源及必要验证；主管定向核实，不让其他模型全量重审。日志可留证，但文件或系统通知不代替主管收到结果。
- 原会话/请求失效或通道中断时报告真实状态，不重复创建任务；本任务不重开已终止的原主管迁移试验，未来新授权另行界定。接入验证采用一次真实小任务，不增加空轮询或演示链。

## 8. 多模型作者、自审与完成交接

- Devin 是执行宿主，不限于机械任务或审计；选用 OpenAI/Claude 模型不改变 `EXECUTOR`/`CURRENT_WRITER`。模型路线、已冻结关键仓库实现资格和额度备用路线只引用 `GPT-CONTROL-V2` §2，不在本文件复制型号表；加载 `CLAUDE.md` 不自动变成 Claude Code 作者或获得其他领域权限。
- 每项实施交付前自审实际 diff、直接调用链、类型、错误处理、边界和必要回归，修复范围内普通问题，完成直接测试及必需页面/功能验证，再做获准 Git 收尾；不能只交代码或问题清单，不让主管/Codex 补做作者验证。细则见 `TEAM-COLLAB-V1` §8.1。
- 复杂前端专项审计优先交 Claude，非前端审查按中央路由；审查者默认只读、原作者修复、定向复验。作者自审不等于独立审查，不得自授最终 `ACCEPTED`。
- 同一 Devin 作者按已批准备用路线换模型时，先确认旧调用停写，保留任务、有效 session、branch/worktree 和相关未提交工作；不为换模型强行 commit/push、不重做旧成果。跨作者交接遵守已 push 精确 SHA 与未提交工作规则；失联或额度不足不允许第二作者抢占。

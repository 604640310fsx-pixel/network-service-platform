# NextTrace 去回程反向触发候选模块

本目录仍是离线候选实现：没有远程部署、没有运行 NextTrace、没有新增
cron，也没有修改当前采集器、Kuma、正式 Dashboard 或 SQLite schema。

## 拓扑与固定范围

飞牛无法主动 SSH 到 R5S，因此不再由飞牛拉取：

1. R5S 本地的 `r5s/run_and_push.sh` 以独立非阻塞锁启动。
2. R5S 依次按 `eth0.20 + 192.0.2.12`、`eth0.30 +
   192.0.2.13`、`eth0.10 + 192.0.2.11` 获取三条 WAN 公网 IPv4。
3. R5S 按 `routes.json` 的配置顺序，选择所有同时满足
   `return_enabled=true` 与 `authorization_status=confirmed` 的目标。当前为
   7 台（不含 Alibaba Cloud），每台依次执行三 WAN × ICMP/TCP，总计 42
   条去程。每次都由 `route_probe.sh` 同时校验并传入 `--dev` 和
   `--source`，并且目标 IP 必须命中脚本内的固定 allowlist。
4. R5S 将 3 条公网 IP 记录与 42 条去程记录封装为严格的 45 行 JSONL；
   单行上限 1 MiB，总包上限 8 MiB。按照上限计算，45 行包的平均可用
   空间约为 182 KiB/行；真实 NextTrace JSON 应显著低于此值，超限会在
   推送前直接拒绝。
5. R5S 使用全新的 `route_push_ed25519` 专用密钥，把标准输入推给飞牛
   forced-command `ingest_and_return.py`。该密钥不得复用飞牛用于 VPS 的
   `route_ed25519`。
6. 飞牛先验证完整包、绑定关系、目标名称/IP 配对、顺序、大小和 JSON，
   再保存 42 条去程。
7. 飞牛使用现有 `route_ed25519`，通过 VPS 上已有的受限命令
   `route-return icmp IP` 或 `route-return tcp IP 20001`，依次执行
   7 台 VPS × 3 WAN × 2 协议，共 42 条回程。

Alibaba Cloud 不在这 7 台去回程 VPS 中；其回程 SSH 与受限 runner 尚未授权。

## R5S NextTrace 版本硬要求

R5S 去程不得再使用 `/usr/bin/nexttrace` 1.5。实测该 Linux 构建虽然接受
`--dev` 与 `--source`，三 WAN 的旧 6 条记录却实际都从 `eth0.10` 发出，
因此这些旧去程数据无效，不得用于判断电信、移动路线。

候选脚本固定使用
`/root/network-monitor/bin/nexttrace-1.7.1`（仅允许通过
`ROUTE_NEXTTRACE_BINARY` 显式覆盖）。该候选已用三 WAN 各一次、最多 3
跳的只读验证确认首跳分别匹配 `eth0.20`、`eth0.30`、`eth0.10`。正式替换
前仍须保留二进制校验值和回滚文件；脚本发现该路径不可执行时只报错，
绝不回退到 1.5。

R5S 与 VPS 两端命令都带 `--always-rdns`。规范化时同一 TTL 仍只显示一
行，但会从相同 IP 的三个 probe 中合并任一非空 `Hostname` 到 `reverse`，
避免首个 probe 没有 Hostname 时误显示为空。

## 9 行旧包的安全迁移

接收器应先于 R5S 发送脚本部署。迁移期间
`r5s_push.accept_legacy_bundle=true`，接收器只额外接受原有的严格 9 行
布局：3 条公网 IP + 6 条 DMIT Premium 去程；目标名称/IP、WAN 顺序、
协议顺序和绑定仍逐项校验，不接受其他 9 行变体。确认 R5S 已连续发送
45 行 `multi-target-v1` 后，把该开关改成 `false`，即可永久关闭旧包。

## 强制命令边界

R5S push 公钥在飞牛的 `authorized_keys` 条目应采用以下形态（只使用公钥
内容，绝不能复制任何私钥）：

```text
restrict,command="/usr/bin/python3 /vol1/1000/network-monitor/routes/ingest_and_return.py" ssh-ed25519 AAAA... route_push
```

接收器还会要求 `SSH_ORIGINAL_COMMAND` 必须精确为
`ingest-route-bundle`。它不接受路径、参数、shell 片段或其他命令。

## 防误执行与故障语义

- `deployment_enabled` 只代表接收端已有批准；R5S 仍必须同时存在独立的
  `/root/network-monitor/routes.enabled`，缺任一条件都不得执行。
- R5S 脚本还要求显式存在 `/root/network-monitor/routes.enabled`。
- `orchestrator.py --execute` 永远拒绝，避免退回已证实不可达的
  “飞牛 SSH 到 R5S”旧架构。
- R5S 和飞牛各使用主机本地的 `/tmp/network-monitor-routes.lock`；均为
  非阻塞锁，获取失败立即记录/退出，不等待、不并发。
- 18:00–19:10 Asia/Shanghai（含端点）为硬阻断窗口；任务开始前、R5S
  每个探针前、推送前、飞牛接收前及每条回程前都会复核。
- 所有网络动作只尝试一次；SSH 明确使用 `ConnectionAttempts=1`，没有
  自动重试或自动修复。
- 单个探针失败会进入 bundle 并按失败记录落库，不会修改任何网络配置。
  若某 WAN 公网 IP 获取失败，对应 7 条回程记录为
  `public_ip_missing`，不会向 `0.0.0.0` 发起探测。

## 串行、最长时间与基础采集共存

- 42 条 R5S 去程严格串行，`parallel_requests=1`，同一时刻最多一个
  NextTrace；42 条回程也严格串行。它不执行带宽测速，不会占满宽带。
- 按每次去程 75 秒、公网 IP 每次 12 秒、回程每次 90 秒的硬上限，理论
  最坏时间为：R5S 53 分 06 秒、飞牛回程 63 分、端到端 116 分 06 秒。
  正常响应时会远低于该上限。
- R5S 推送阶段的 4500 秒 SSH 上限只覆盖飞牛侧回程，高于其 3780 秒
  理论上限。04:20 每日任务即使达到理论上限也不会碰到 18:00–19:10
  黑窗或下一日任务。
- 路由任务继续使用独立的非阻塞锁；每分钟 ICMP/TCP 采集不共享该锁，
  不会因日路由耗时而被整段跳过。两者相遇时也只有一个串行 NextTrace
  与单轮轻量探测并存，不会产生 NextTrace 并发。

## 数据保存

- 接收到的原始 JSONL 包保存到 `logs/routes/incoming/YYYY-MM-DD/`，重复
  `bundle_id` 会被拒绝。
- 每条去程/回程仍分别保存原始 JSON 与规范化 JSON，权限 600。
- `route_runs` 只写原有 11 列摘要；启动前严格比较列集合，不迁移 schema。
- NextTrace 的真实 `Hops=[[probe,probe,probe], ...]` 会按 TTL 合并成一
  行；`RTT` 的 Go duration 纳秒值除以 `1e6` 后才作为毫秒显示。
- 当前三 WAN 公网 IP 原子写入 `data/public-ip.json`。

## 离线检查

以下操作不会执行任何网络命令：

```sh
python3 routes/orchestrator.py
python3 -m unittest discover -s routes/tests -v
python3 -m py_compile routes/core.py routes/orchestrator.py routes/ingest_and_return.py
sh -n r5s/route_probe.sh
sh -n r5s/public_ip_probe.sh
sh -n r5s/run_and_push.sh
```

本次修改只生成本地候选，不触碰现有密钥、known_hosts、启用标记或每日
调度。后续更新必须先备份并部署接收器/配置，验证旧 9 行包仍可接收，再
部署 R5S 1.7.1 与 45 行发送脚本；任何一步失败都恢复原文件，不修改网络
配置。

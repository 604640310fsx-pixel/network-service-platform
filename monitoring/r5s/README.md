# R5S 采集器部署前置条件

1. Codex 必须先取得 `root@192.0.2.1` 的公钥登录；不得使用聊天中出现过的密码。
2. R5S 没有 Python 3。经验证现有 curl/libcurl 8.19.0 支持 `ifhost!设备!源IP`，候选 shell 采集器以该语法同时固定设备和源地址，不安装软件。
3. TCP 探测必须使用 `--interface ifhost!eth0.10/20/30!源IP`；采集结果同时核对 curl 返回的 `local_ip`。
4. ICMP 命令固定为 `ping -I eth0.10/20/30 -c 4 -W 2`。
5. 定时任务启用前必须先手动连续验证，确认路由、接口、CPU 和数据库结果。

## 每日 NextTrace 候选（不属于每分钟采集器）

- 去程必须使用 `/root/network-monitor/bin/nexttrace-1.7.1`；旧
  `/usr/bin/nexttrace` 1.5 的 `--dev` 绑定在此设备上无效，旧三网去程
  数据不可作为线路依据，脚本也不会自动回退。
- `run_and_push.sh` 固定串行执行 7 个已确认目标 × 三 WAN × ICMP/TCP，
  共 42 条去程，并与三条公网 IP 元数据组成严格 45 行 bundle。
- 每条去程继续同时校验设备和源地址，目标名称/IP 必须命中双重
  allowlist；单条 1 MiB、总包 8 MiB，任何超限立即停止推送。
- NextTrace 加 `--always-rdns`；所有动作无重试，并继续服从独立非阻塞锁
  与 18:00–19:10 黑窗。详细迁移顺序见 `routes/README.md`。

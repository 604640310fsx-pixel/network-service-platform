# 三网线路监控（阶段二 A）

本阶段只包含：SQLite、只读面板骨架、三网 ICMP/TCP 采集器。没有 NextTrace、iperf3、Kuma 写入或网络配置修改。

采集约束：ICMP 使用 `ping -I` 固定接口；TCP 使用 Python socket，先 `SO_BINDTODEVICE` 固定设备，再 `bind((source_ip, 0))` 固定源地址。采集器只允许 TCP 端口 20001。每分钟启用 Yecaoyun Cloud、DMIT Premium、Zillion Network 三个不同网络的 TCP 目标，其他已知端口只保留为禁用配置。

`203.0.113.10` 的 TCP 端口仅作为示例，默认不会探测。

数据库写入只由 `scripts/ingest.py` 完成；Dashboard 以 SQLite 只读模式打开数据库，API 只有 GET。

## 买家 VPS 目录同步

`config/targets.json` 的 `tcp_targets` 是 3002 监控页、后台买家交付下拉框和提交校验共用的唯一 VPS 目录。每项可增加：

```json
{
  "name": "Stable Internal Key",
  "display_name": "买家和管理员看到的脱敏名称",
  "customer_state": "active"
}
```

`customer_state` 只允许：

- `active`：监控页显示实时状态，并允许后台新分配给买家；
- `disabled`：监控页显示为已停用，后台保留可见但禁止新分配；
- `retired`：不再出现在普通监控选择器和新分配列表中，仅为已有买家绑定保留退役证明。

旧配置没有 `customer_state` 时保持兼容：`enabled: false` 视为 `disabled`，其余视为 `active`。修改配置应先写入同目录临时文件、验证 JSON 后原子替换；监控与后台最长约 15 秒同步。更换 VPS 时应先新增新 key，再将旧 key 标记为 `retired`；确认数据库中没有已有买家绑定后，才允许物理删除旧项。不得复用旧 key 指向另一台 VPS，避免已有买家链接被静默改线。

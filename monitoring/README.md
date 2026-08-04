# 三网线路监控（阶段二 A）

本阶段只包含：SQLite、只读面板骨架、三网 ICMP/TCP 采集器。没有 NextTrace、iperf3、Kuma 写入或网络配置修改。

采集约束：ICMP 使用 `ping -I` 固定接口；TCP 使用 Python socket，先 `SO_BINDTODEVICE` 固定设备，再 `bind((source_ip, 0))` 固定源地址。采集器只允许 TCP 端口 20001。每分钟启用 Yecaoyun Cloud、DMIT Premium、Zillion Network 三个不同网络的 TCP 目标，其他已知端口只保留为禁用配置。

`203.0.113.10` 的 TCP 端口仅作为示例，默认不会探测。

数据库写入只由 `scripts/ingest.py` 完成；Dashboard 以 SQLite 只读模式打开数据库，API 只有 GET。

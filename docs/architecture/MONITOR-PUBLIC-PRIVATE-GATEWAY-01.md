# MONITOR-PUBLIC-PRIVATE-GATEWAY-01 架构裁决

## 状态

- `DECISION_TYPE: FROZEN`
- 用户批准日期：2026-09-01
- 当前生产发布：`NO-GO`
- 本记录只冻结仓库实现边界，不授权连接 FNOS、安装连接器、配置 VPS、
  DNS、证书或生产环境，也不授权部署。

## 唯一主架构

监控能力拆分为四个信任域：

1. 独立 HTTPS `PUBLIC_MONITOR_ORIGIN`：匿名脱敏三网页面、mini 页面、必要
   静态资源和已审计只读 GET API；
2. 网站同站 `/status` + Auth Service BFF：沿用网站 Session，只返回当前
   用户获准资源；
3. 私有 `MONITOR_API_ORIGIN`：仅 overlay、loopback 或私有解析可达，使用
   mTLS 服务身份，浏览器永不访问；
4. operator-only 原始 3002：只允许授权运维人员经私有覆盖网络访问。

`VITE_MONITOR_URL` 只能指向第 1 层，`MONITOR_API_ORIGIN` 只能指向第 3
层，二者必须分离。原始 3002 不得成为公开或普通客户页面的透明上游。

## 公开策略

匿名 `/monitor` 和侧栏 mini 只显示电信、移动、联通三网的身份无关摘要：

- 固定线路标识和显示名称；
- 最新探测成功时的延迟；
- 当前窗口脱敏丢包摘要；
- `healthy | degraded | unavailable | no_data | stale`；
- 最近更新时间和明确的 stale 标记；
- 有限、降采样且不含目标身份的趋势。

最新探测失败时不得使用上一次成功值冒充当前值。上游失败不得回退
Mock，也不得继续返回缓存成功数据并标成实时。数据明确过期时可以返回
`200 + stale=true`，但当前延迟、丢包和趋势必须清空。

## 公开字段白名单

每条 WAN 只允许：

```text
wanId
displayName
status
latestLatencyMs（仅最新探测成功时存在）
packetLossSummary
updatedAt
stale
trend
```

管理员安全目录只允许：

```text
opaqueTargetKey
adminSafeDisplayName
assignable
onlineStatus
stale
updatedAt
```

普通登录客户只能在公开摘要基础上看到本人服务的客户侧名称、状态和更新
时间；不得看到其他客户、全量 VPS 目录或原始监控身份。

## 禁止公开内容

匿名或普通客户的 HTML、JavaScript、API、source map、Network 响应、错误页
和公开日志均不得包含：

- 源地址、目标地址、目标名称、接口、内部或公网节点地址、内部端口；
- 真实 VPS 主机名、完整 VPS 目录、供应商资源标识和地址映射；
- CPU、内存、存储、上下行、运行时间；
- 逐跳地址、反向解析、原始 ASN、原始路由和内部地区拓扑；
- 配置或数据库路径、原始异常堆栈和响应正文；
- 连接器地址、凭据、隧道密钥、服务证书私钥。

公开投影必须构造全新对象并再次按字段白名单校验，不能通过“删除一组已知
字段”实现。上游 Schema 缺失或异常时整体 fail closed。

## 公共与私有 HTTP 边界

公共 origin：

- 只提供脱敏页面、mini、必要静态资源和脱敏 GET API；
- API 只允许 GET，HTML/静态资源允许 GET/HEAD；
- POST、PUT、PATCH、DELETE 返回 405；
- API 和 HTML `Cache-Control: no-store`；
- 不配置 Cookie，不接收网站 Session，不开放跨域 CORS；
- 同源请求私有 BFF，错误不得包含上游信息；
- 基线限流为每客户端 IP 每分钟 30 次、burst 10；
- `frame-ancestors` 只允许最终批准的网站 origin，公共 iframe 不发送会
  阻止跨 origin 嵌入的 `X-Frame-Options`。

私有 origin：

- 无公网 DNS，不绑定公网 listener，不进入任何 `VITE_*` 或浏览器产物；
- 仅允许批准的 GET，返回 `Cache-Control: private, no-store`；
- 不设置 CORS，不记录完整 URL、查询值、内部地址或响应正文；
- 使用 mTLS，每个调用方使用独立、可单独轮换和撤销的客户端证书；
- 依据服务身份和固定路径执行 ACL，不共享万能 Token。

身份固定拆分为：

```text
PUBLIC_BFF_IDENTITY      只读三网脱敏摘要
AUTH_SERVICE_IDENTITY    只读获准的客户/管理员安全投影
OPERATOR_IDENTITY        独立私有边界上的完整运维访问
```

## 故障映射

- upstream timeout：504 或安全 `monitor_unavailable`；
- overlay/连接失败：503；
- upstream Schema 非法：502；
- stale 数据：200 + `stale=true`，不返回过期指标作为当前值；
- 所有失败响应不含原始异常、旧成功指标或 Mock。

## 连接器裁决与当前停止线

连接器方向冻结为“自有公网 VPS + FNOS 主动出站 WireGuard 类覆盖网络”。
家庭网络不得开放监控入站端口，不依赖固定公网地址、DDNS 或公网主动拨入。
WireGuard peer 与应用 mTLS 身份必须分别轮换和撤销，不自动回退持久反向
SSH。

本任务没有部署授权。公共域名、自有 VPS、canonical 网站 origin、Auth
Service overlay 可达性、证书轮换负责人、运维授权角色和告警/回滚负责人
仍为生产前必须补齐的事实。任何实现若要求公开原始 3002、把私有 origin
送进浏览器、开放家庭端口、回退旧缓存/Mock 或共享万能凭据，均保持
`NO-GO`。

## 当前仓库任务边界

`MONITOR-PUBLIC-PRIVATE-GATEWAY-01` 只允许仓库实现和离线测试：公开脱敏
页面/BFF、私有监控接口、字段投影、禁止字段扫描、method allowlist、
no-store、日志脱敏、mTLS 身份模型、故障映射和监听边界。

后续 `/status` 用户归属、管理员目录、网站 iframe/CSP 最终接线、连接器
staging、生产 preflight 和发布必须分别立项与授权。

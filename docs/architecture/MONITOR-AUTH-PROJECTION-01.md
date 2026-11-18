# MONITOR-AUTH-PROJECTION-01 冻结契约

## 状态与权限

- `DECISION_TYPE: FROZEN_FINAL2`
- 仓库实施任务：`MONITOR-AUTH-PROJECTION-IMPLEMENT-01`
- 当前生产发布：`UNVERIFIED / NO AUTHORITY`
- 本记录只冻结仓库内的账户监控投影，不提供域名、地址、证书、私钥、
  运行账户或其他生产值，也不授权安装、迁移、部署、流量切换或生产访问。

实现候选、Draft PR 和 CI 结果都不等于管理验收、合并、发布或生产可用。

## 唯一数据流与信任边界

```text
authenticated browser /status
  -> same-origin GET /api/me/monitor-status
  -> Auth validates the existing web-audience session and user role
  -> Auth selects one owned delivery binding in SQL
  -> dedicated auth_service client over private HTTPS + mTLS
  -> monitor gateway fixed raw lookup and fresh allowlisted projection
  -> Auth constructs the exact customer object
  -> Website strict parser and lifecycle UI
```

浏览器不得提交、选择或看到监控 target，也不得调用公开、原始或私有监控
origin。公开匿名 `/monitor` 与本账户投影保持独立；任何失败都不得回退公开
origin、iframe、Mock、旧成功结果或持久缓存。

## Auth 归属与选择

选择器只接收数据库依赖与已认证的 `principal.userId`。归属和状态必须在
同一 SQL 中完成：

```text
services.payment_id = payments.id
payments.order_id = orders.id
orders.user_id = principal.userId
orders.status = paid
payments.status = paid
services.status = open
ORDER BY services.id DESC, service_delivery_items.position ASC
```

不得假设或添加 `services.order_id`。按以上顺序只跳过
`monitor_target_key IS NULL` 的交付行，选择第一条非空绑定。选择后即固定：
key 非法、目录缺失、disabled、retired 或状态读取失败时都不得改选下一条
线路、服务或 target。stale target 仍保持被选中。

- 无符合归属及 paid/paid/open 条件的服务：`404 no_eligible_service`；
- 有符合条件的服务但所有交付行均未绑定：`409 monitor_unbound`；
- 所选 target 缺失、disabled 或 retired：`409 monitor_unbound`；
- 管理员调用客户端点：`403 forbidden`，既有管理员流程不变。

客户可见的 `GET /api/pay/orders/:orderRef`、
`GET /api/me/delivery-lines` 及其客户 mapper 均不得返回
`monitorTargetKey`。管理员专用交付和目录接口继续保留 opaque key；存储数据
不删除、不迁移。

## HTTP 契约

三个接口都只接受 GET。其他方法返回 `405 method_not_allowed` 和
`Allow: GET`；任何 query/body 违反各自规则时返回 `400 invalid_request`。
所有成功与失败均为 UTF-8 JSON、`Cache-Control: no-store`，错误只能是：

```json
{"error":{"code":"..."}}
```

不得返回平铺错误、额外错误字段、上游正文或原始异常。

### 浏览器同源 Auth 接口

```text
GET /api/me/monitor-status
query: none
body: none
```

成功对象只允许：

```json
{
  "label": "账户服务器名称",
  "status": "online",
  "updatedAt": "2030-01-01T00:01:00Z",
  "stale": false
}
```

`status` 只能是 `online | offline | stale`；`stale` 必须与 status 一致；
`updatedAt` 必须是 UTC 秒精度；label 为 1–200 个无控制字符的 trim 后文本。
允许的错误映射是：

| HTTP | code |
| ---: | --- |
| 400 | `invalid_request` |
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `no_eligible_service` |
| 405 | `method_not_allowed` |
| 409 | `monitor_unbound` |
| 429 | `rate_limited` |
| 502 | `monitor_invalid_response` |
| 503 | `monitor_unconfigured` 或 `monitor_unavailable` |
| 504 | `monitor_unavailable` |

Cookie 建立 `principal.userId` 后，其他请求 header 均不具权威性，不得改变
选择或结果，也不得产生 monitor 专用 400。只沿用已有 principal-HMAC 限流
状态，purpose 为 `monitor:status:user`，每个已认证 user 每小时接受 120 次；
检查位置在认证之后、数据库选择与上游工作之前。此只读 GET 不要求 CSRF。

### Gateway 私有目录

```text
GET /api/auth-service/targets
identity: auth_service only
query: none
body: none
```

成功仅允许最多 100 个、source order、key 唯一的项目：

```json
{"items":[{"key":"opaque","label":"账户服务器名称","state":"active"}]}
```

项目字段严格为 `key,label,state`，state 只能是
`active | disabled | retired`；仅 active 可分配。

### Gateway 私有状态

```text
GET /api/auth-service/status?target=<encoded>
identity: auth_service only
query: exactly one target
body: none
```

target key 为 1–128 个无控制字符的 trim 后文本。成功仅允许：

```json
{"status":"online","updatedAt":"2030-01-01T00:01:00Z","stale":false}
```

私有接口允许的错误为 `400 invalid_request`、`403 forbidden`、
`404 target_not_found`、`405 method_not_allowed`、
`409 target_unavailable`、`502 monitor_invalid_response`、
`503 monitor_unavailable`、`504 monitor_unavailable`。Gateway 404/409 在 Auth
客户接口统一映射为 `409 monitor_unbound`；connecting 或无当前数据映射为
`503 monitor_unavailable`。

## mTLS 与 ACL

私有 HTTPS 最低 TLS 1.2，必须验证服务端证书链与 hostname，并由 Auth 提供
专用客户端证书和私钥。`auth_service`、`public_bff` 与 `operator` 是不同、
可独立轮换和撤销的证书指纹身份：

| identity | allowed private route |
| --- | --- |
| `public_bff` | `/api/public-summary` only |
| `auth_service` | `/api/auth-service/targets` and `/api/auth-service/status` only |
| `operator` | none on this listener |
| unknown | none |

Auth 的逻辑配置名称固定为：

```text
MONITOR_AUTH_PROJECTION_ENABLED
MONITOR_AUTH_PRIVATE_ORIGIN
monitor_private_ca_certificate
monitor_auth_service_client_certificate
monitor_auth_service_client_private_key
```

前三个逻辑 credential 文件由现有 credential source 提供；仓库不保存值。
Gateway 继续使用既有 `AUTH_SERVICE_IDENTITY_CERT_FILE` 身份证书表面。公开
gateway 的既有 `MONITOR_API_ORIGIN` 不是 Auth 投影配置，严禁将它用于本
链路或作为回退。

## Bounds、超时与失败关闭

| boundary | maximum |
| --- | ---: |
| Browser response body | 4 KiB |
| Auth private status body | 8 KiB |
| Auth private catalog body | 64 KiB |
| Gateway raw status body | 64 KiB |
| Gateway raw catalog body | 256 KiB |
| target key | 128 characters |
| customer label | 200 characters |

Gateway raw 单请求 timeout 为 5 秒；Auth 整体请求预算 6 秒；Website 请求
预算 7 秒。各层禁止 redirect 和 retry。TLS/ACL/connect 失败为 503，timeout
为 504；redirect、非 JSON、body 超限、字段缺失/多余/类型错误、状态不一致
或平铺错误均 fail closed 为 502。SPA HTML 永远不是成功响应。

## 隐私、日志与客户字段

每一跳都构造全新的 allowlisted 对象。客户成功对象严格只有
`label,status,updatedAt,stale`；私有状态严格只有
`status,updatedAt,stale`。普通客户响应、浏览器资源、日志和错误不得包含：

```text
target/key, host, address, port, path, provider, topology, metrics, traffic,
subscriptions, database IDs, order refs, user IDs, certificate data, secrets,
raw bodies, raw errors
```

不得记录完整 URL、target/query、session、CSRF、label、证书、上游 URL、
私有正文或异常。原始 dashboard 请求日志必须关闭会泄露 target query 的
默认 request-line 输出。

## Website 生命周期

`/status` 明确呈现 loading、online、offline、stale、无合格服务、未绑定、
未认证/Session 过期、forbidden、rate limited、unavailable/timeout、malformed
response。初次加载和手动重试都先清除旧结果；mount 仅发起一次请求，同时
最多一个 in-flight；无 polling；重试只能手动；unmount/retry 会 abort 或
忽略迟到结果。

## 验收与生产停止线

仓库候选必须通过 Auth 全量 test/typecheck、Website 全量 test/check/build、
Gateway unittest/compile、dashboard-next tests、release validators、合成 CA
mTLS/ACL/rotation/hostname、客户字段移除及 loopback 浏览器矩阵。浏览器矩阵
为 1440x900 与 390x844、light 与 dark、success/stale 及
401/403/404/405/409/429/502/503/504，并要求零横向溢出、零 console error、
零 target 泄露。

即使以上全绿，下列仍保持 `UNKNOWN/UNVERIFIED`：实际 origin、证书与私钥
材料、权限、运行时目录绑定、DNS/可达性、进程重启、Nginx 激活、真实客户
行为、部署和流量。补齐它们需要新的明确权限与目标绑定；本契约不授权为
验证而连接任何外部或生产系统。

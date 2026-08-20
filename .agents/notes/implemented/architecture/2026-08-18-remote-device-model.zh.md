# Agent Note: 远程访问设备模型 —— 一次性配对 token、可吊销注册表与仅桌面控制面

Status: implemented

[English](2026-08-18-remote-device-model.md) | 中文

## Problem

远程访问能力（公网 HTTPS 隧道 + Web GUI 配对闸门）原用**按日有效的 HMAC 票据**配对：当日任意设备均可配对，30 天 cookie 不携带设备身份，因此无法单独吊销某台手机——只能轮换主密钥（把所有人踢下线）——也没有界面内状态，终端二维码是唯一呈现。第三方 `@linxin666/dsh-remote-web-ui` 提供了缺失的体验（界面内面板、设备吊销、实时状态），但是一套平行实现：自己的隧道、自己的配对存储、绕过平台 RPC 面的 `/m/api` 代理。

## Decision

**把移动端远程控制体验吸收进一方案件 remote 家族，复用现有隧道与平台协议。** host 配对闸门升级为**设备模型**：

- **一次性配对 token** 取代日票：32 随机字节、15 分钟 TTL、单活跃（新签发即作废旧 token）、恰好消费一次。终端与界面内二维码都编码 `…/pair/<token>`。
- **设备作用域 cookie v2**（`dsh_remote = v2.<deviceId>.<expiresDay>.<mac>`）：HMAC 绑定设备 id，`authorize` 还要求设备在持久化注册表（`$DSH_HOME/secrets/remote-roster.json`，0600）中**存活**。吊销即删除记录，下一次请求返回 401——无需轮换主密钥。
- **`/remote/*` 控制面**挂在主 webserver 上、仅桌面可达：代理给每条转发请求盖 `x-dsh-proxied: 1`（入站同名头剥除），控制面据此拒绝一切隧道来源请求——已配对的手机不能管理其他设备。端点：`GET /remote/state`、`GET /remote/devices`、`POST /remote/pair/issue`、`POST /remote/stop`、`POST /remote/devices/<id>/revoke`、`POST /remote/devices/<id>/rename?name=<标签>`。
- **设备标签默认可区分、且可由用户改名。** 新设备的 `name` 由其配对 User-Agent 派生出「系统 · 浏览器」（如 `iPhone · Safari`、`Android · Chrome`、`Windows · Edge`），不再是一刀切的 `mobile`/`desktop`，多台手机的列表一眼可辨；面板可把任意设备改成自定义标签，与注册表其他字段一样持久化。
- **事件走既有 allowlist 桥**：`remote/devices/change`（注册表快照）与 `remote-tunnel/state` 经 `API_REMOTE_FORWARDED_EVENTS` → `ctx.remote.$on`，面板无需新线路即可实时。
- **`--remote-reset`** 现在轮换密钥**并**吊销全部设备。

**新双面包 `@deepseek-ai/dsh-client-ui-remote` 拥有客户端表面**：桌面面板（侧栏底手机入口 → Modal：二维码、隧道徽标、设备列表、停止/刷新/复制）与独立 `/m` 移动 bundle。`/m` 是自举的轻量 React 应用，复用平台 `/api` unary RPC 与 `events.mux` WebSocket——**不是平行 `/m/api`**——因此设备 cookie 即可鉴权，session-log 纪律成立（渲染派生自 `session.history`/`session/event`；发送走 `session.prompt`/`session.selectModel`/`session.rename`）。

## Consequences

第三方的平行隧道/配对/`/m/api` 不再移植；其 `remote-web-ui` 更新功能不在范围。日票、`pairingTicket`/`verifyTicket` 与 cookie v1 删除（预发布：无兼容垫片）。为 remote-access 与 remote-tunnel 新增 `./types` 子路径，使 api-remotes allowlist 与 api-proxy 转发循环能看到新事件；api-remotes 与 host-apiproxy 两个 face 引用这两个包。从 web profile 卸载 `@linxin666/dsh-remote-web-ui` 是独立步骤，需用户确认后才执行。

## Alternatives considered

- **保留第三方插件、让它复用一方案件基础设施** —— 维持了所有权分裂、留下两套配对存储；因该功能是产品核心且一方案件已拥有隧道与闸门而否决。
- **在日票之上叠加设备模型** —— 一个"当日任意设备可配对"的票据无法表达"只吊销手机 A"；一次性 token 是携带设备身份的最小单元。
- **`/m` 复用完整 client-runtime** —— 独立页面没有 cordis/shell 模块表；基于平台协议的薄 wire 层是最小的正确表面。

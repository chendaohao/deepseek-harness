# @deepseek-ai/dsh-client-ui-remote

[English](README.md) | 中文

Web GUI 的远程控制表面。两半：

**桌面面板** —— 侧栏底部设置旁的手机图标入口（`sidebar.footer.action`）打开一个 modal，展示隧道状态徽标、一次性配对二维码、带逐设备改名与吊销的已配对设备列表，以及停止全部操作。数据走仅桌面的 remote-access 控制面——`GET /remote/state`、`POST /remote/pair/issue`、`POST /remote/devices/<deviceId>/revoke`、`POST /remote/devices/<deviceId>/rename`、`POST /remote/stop`——以及面板打开期间转发的 `remote/devices/change` 与 `remote-tunnel/state` 事件。

**移动表面（`/m`）** —— 启用时（随附 bundle 行从 `--remote` 派生 `enabled`）node half 在 `/m` 服务一个独立小屏界面（文档壳 + 自包含 `lib/mobile.js` bundle）。手机配对后，页面通过桌面 UI 使用的同一平台 `/api` 传输与 host 通信——unary RPC（`session.list`、`session.history`、`session.prompt`、`session.models`、`session.selectModel`、`session.rename`、`workspace.list`、`session.search`、`session.create`）加 `events.mux` WebSocket 接收实时 `session/event` 帧，socket 无法投递时退化为 `session.history` 轮询。设备 cookie 负责鉴权；不存在独立的移动通道。渲染只派生自 history 拉取与实时帧——会话日志是真源。

移动客户端为打开的 socket 运行空闲看门狗（`idleTimeoutMs`，默认 45 秒；0 关闭）：任何到达的帧（含宿主心跳）都会重置计时器，静默死亡的传输（手机切换移动数据 ↔ WiFi，无 close 帧）会在超时后回收进轮询回退 + 重连路径——与桌面 connection 包的心跳/看门狗对同一失效模式。

## Model Experience

None。移动表面在 `/api` 线上渲染浏览器 UI，自身从不组装或发送 provider 请求。

#### KV Cache effect

None。

## Known Limitations and Deferred Work

- `/m` 页面与 `/api` 传输需要设备 cookie；未配对打开 `/m` 显示的是设备闸门的拒绝，而非引导流程。
- 控制面路由仅 loopback（隧道流量被拒），因此 host 隧道关闭或浏览器处于远端时，桌面面板读到的是空/错误状态。
- 移动表面以单个 ESM bundle（`lib/mobile.js`）交付，由包内独立 tsdown 入口从源码内联；`/m` 路由可服务前必须先跑 `bundle` 脚本，在此之前 node half 返回 500。
- 配对二维码一次只签发一个（新签发即作废旧 token），因此面板显示单个二维码，而非轮换集合。

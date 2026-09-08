---
description: "浏览器侧远程控制表面：桌面配对/设备面板，渲染在 remote-access 控制面之上。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-remote

[English](README.md) | 中文

## 概述

Web GUI 的浏览器侧远程控制表面。侧栏底部设置旁的手机图标入口（`sidebar.footer.action`）打开桌面面板：隧道状态徽标、一次性配对二维码、带逐设备改名与吊销的已配对设备列表，以及停止全部操作。数据走仅桌面的 remote-access 控制面——`GET /remote/state`、`POST /remote/pair/issue`、`POST /remote/devices/<deviceId>/revoke`、`POST /remote/devices/<deviceId>/rename` 与 `POST /remote/stop`——以及面板打开期间转发的 `remote/devices/change` 与 `remote-tunnel/state` 事件。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

无：远程表面在 `/api` 线路上渲染已记录的状态，从不组装或发送 provider 请求。

#### KV Cache effect

无；面板不组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **控制面仅限 loopback** —— 隧道流量被拒绝，因此 host 隧道关闭或浏览器处于远程时，桌面面板读到的是空/错误状态。
- **一次只有一个二维码** —— 新签发会使上一个 token 失效，面板展示单个二维码而非轮换集合。

<a id="dev-note"></a>
### 不变量归属

未发布运行时不变量伴生文件，因为本表层经 /api 线路渲染已入账状态；没有持久或模型可见内容需要在启动时复核。

### 开发备注

<details>
<summary>面板如何接线</summary>

桌面面板通过 `sidebar.footer.action` 槽位挂载，并仅在打开期间订阅转发的 remote 事件。导出纪律遵循 packages/client/AGENTS.md：不跨插件值导入；`ctx.remote`、`ctx.slots`、`ctx.locale` 为注入的 peer。

</details>

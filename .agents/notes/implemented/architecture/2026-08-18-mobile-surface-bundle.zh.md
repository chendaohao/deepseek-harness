# Agent Note: /m 移动表面 —— 基于平台协议的独立 bundle

Status: implemented

[English](2026-08-18-mobile-surface-bundle.md) | 中文

## Problem

手机远程控制需要小屏表面，但桌面 Web GUI 是 cordis 插件组合：每个浏览器半边都是假设 shell 模块表与运行时已挂载的 `__ModuleLoader__` bundle。手机页面无法启动该 shell，而把桌面 UI 塞进手机视口是与配对流程承诺的移动控制面不同的产品。第三方插件用平行 `/m/api` 代理与自有线格式解决——这是平台不拥有的第二套协议。

## Decision

**`/m` 是独立、自举的 React bundle，直接说平台协议。** 它在 `@deepseek-ai/dsh-client-ui-remote` 中与桌面面板的插件 bundle 并列构建：

- **一个包两个 tsdown 产物**：`clientBundle(...)` 产出桌面面板 `lib/client.js`；第二个配置（`noExternal: () => true`、ESM、`clean: false`、同样的 `define` 块）产出 `lib/mobile.js`——react/react-dom 内联、无 `__ModuleLoader__` 横幅、自包含。node half 从 `lib/` 服务 `/m`（文档壳）与 `/m/mobile.js`，由同一 `enabled` 行门控。
- **平台协议，无 `/m/api`**：手写薄 wire 层调用 `POST /api/<method>`（标准 `client-request`/`server-response` 信封，错误折叠为 result union），并订阅 `/api/events.mux` WebSocket 收 `session/event` 帧，socket 死时退化为带退避的 `session.history` 轮询。设备 cookie 鉴权页面，无额外通道。
- **session-log 纪律成立**：渲染只派生自 `session.history` 数据与 `session/event` 帧；发送走 `session.prompt`；换模型走 `session.selectModel`；标题走 `session.rename`。bundle 自身不持有模型可见状态。
- **三级状态机**（工作区 → 会话 → 聊天），含搜索、建后即开、模型底部弹层、CSS 变量深浅色切换。

## Consequences

wire 层用手写结构校验而非内联 host-apiproxy 的 zod schema（保持 bundle 无 zod、免受 host-only 类型影响）；host RPC map 是唯一真源，方法形态漂移会在解析期被 /m 客户端响亮地失败。`session.list` 按扁平消费（host v1 无游标）。bundle 由包的 `bundle` 脚本重建；`lib/mobile.js` 缺失时 `/m` 返回 500 并附构建提示。

## Alternatives considered

- **/m 复用完整 client-runtime** —— 独立页面没有 cordis/shell 模块表；薄 wire 层是最小的正确表面，也保持 bundle 轻量。
- **移植第三方 `/m/api` 代理** —— 平台不拥有的第二套协议重复了 RPC map 并绕过信任栅栏；平台 unary + events.mux 已覆盖 /m 所需的全部方法。

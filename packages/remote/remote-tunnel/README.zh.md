---
description: "隧道能力 Service（`ctx.remoteTunnel`）：固定版本的 cloudflared 快速与命名隧道，下载经校验。"
kind: "package-reference"
---
# @deepseek-ai/dsh-remote-tunnel

[English](README.md) | 中文

## 概述

`dsh-remote-tunnel` 通过 spawn 一个锁定版本、按官方校验和 SHA-256 验证的 `cloudflared` 发布物，把本地端口暴露到公网 HTTPS URL：快速模式无需 Cloudflare 账号，每个会话铸一个随机 `*.trycloudflare.com` 域名；named 模式在自有稳定域名下运行预注册隧道。`open(port)` 带退避重试并 resolve 一个 `RemoteTunnelSession`（`url`、`close()`）；会话发出 `remote-tunnel/state` 的 `open`、`ended` 或 `failed`。子进程运行于净化后的环境；配置错误在加载时响亮失败。

-----
<a id="operation"></a>
## 运行

配置 `{enabled, download: 'allow'|'deny'|'system', binaryPath?, mode: 'quick'|'named', name?, hostname?}`：`allow` 首次使用时把固定版本的产物下载到 `$DSH_HOME/bin`（macOS tgz 通过系统 tar 解包），`deny` 要求提供已存在的 `binaryPath`，`system` 从 PATH 运行 `cloudflared`。快速模式（默认）无需 Cloudflare 账号，每次会话分配随机主机名；named 模式运行已注册的隧道并挂到稳定的 `hostname`，因此重启后 URL 不变，且要求同时提供 `name`（`cloudflared tunnel create` 得到的隧道名或 UUID）与 `hostname`（裸 DNS 名；会话 URL 为 `https://<hostname>`）。错误配置在加载期即失败：named 缺 `name`/`hostname`、非 named 模式却设置了 `name`/`hostname`、`hostname` 不是裸 DNS 名、`deny` 下缺少 `binaryPath`。下载内容与固定哈希不符时大声失败且不留残余。`enabled` 为 false 或端口非整数/越界时 `open()` 拒绝执行。子进程从经过清洗的父环境启动（不含凭据形状或 `DSH_*` 的名称），但仍携带 `HOME`，因此 named 模式能找到 `~/.cloudflared/{cert.pem,<tunnel>.json}`。

named 模式需要先在部署所属的 Cloudflare 账号下一次性注册隧道才能运行：`cloudflared tunnel login`（浏览器 OAuth 写入 `~/.cloudflared/cert.pem`）、`cloudflared tunnel create <name>`、`cloudflared tunnel route dns <name> <hostname>`，均用固定二进制（或任意匹配的 `cloudflared`）。未执行 `route dns` 时隧道能注册但浏览器会 404，直到 CNAME 记录存在。

重启策略属于消费者：`ended` 后由 [`dsh-remote-access`](../remote-access/README.zh.md) 重新开启会话。

## 目录

- [运行](#operation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----
<a id="model-experience"></a>
## 模型体验

None, as the package owns tunnel transport only; no URL, ticket, or cookie reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **单一 provider** — 目前只有 cloudflared 隧道一种后端；Service 即未来 frp/Tailscale provider 可替换的接缝，但在第二个 provider 出现前不引入注册表。
- **快速模式是临时的** — TryCloudflare 每次会话分配随机子域名，Cloudflare 将快速隧道定位为测试用途；需要固定域名的部署按上文注册命名隧道（`mode: named`）。
- **安装需一次联网** — `download: allow` 首次使用时从 GitHub 拉取固定版本；离线主机请使用 `system` 或 `binaryPath`。

<a id="dev-note"></a>
### 不变量归属

未发布运行时不变量伴生文件，因为隧道的子进程生命周期已由本包测试覆盖；没有需要在启动时复核的所属关系。

### 开发备注

<details>
<summary>Provider 事实</summary>

固定版本（2026.8.1）按平台对照官方发布校验和做 SHA-256 验证；摘要不匹配即大声失败且不保留任何内容。快速模式为每个会话铸造随机 `*.trycloudflare.com` 主机名；named 模式在稳定主机名下运行预注册隧道，使配对 cookie 可跨重启生效。会话发出 `remote-tunnel/state`（`open`/`ended`/`failed`）；重启策略属于消费方。

</details>

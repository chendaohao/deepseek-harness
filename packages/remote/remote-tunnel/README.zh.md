---
description: "隧道能力 Service（`ctx.remoteTunnel`）：固定版本的 cloudflared 快速与命名隧道，下载经校验。"
kind: "package-reference"
---
# @deepseek-ai/dsh-remote-tunnel

[English](README.md) | 中文

## 概述

远程隧道能力：默认导出的 `RemoteTunnel` Service（`ctx.remoteTunnel`）及其 cloudflared provider。`open(port)` 启动固定版本（`2026.8.1`，按官方发布校验和逐平台验证 SHA-256）的 `cloudflared`：快速模式以 `tunnel --url http://127.0.0.1:<port> --no-autoupdate` 运行，在有界的 stdout/stderr 窗口内扫描 `https://<slug>.trycloudflare.com` URL（真实 cloudflared 把横幅日志写到 stderr）；named 模式会写入一份会话级 ingress 配置（`tunnel: <name>`，一条从 `<hostname>` 到 `http://127.0.0.1:<port>` 的 ingress 规则，以及 `http_status:404` 兜底规则），并以 `tunnel --config <file> --no-autoupdate run` 运行，子进程报告连接注册后解析出 `https://<hostname>`。两种模式都带退避地重试启动尝试，最终解析出 `RemoteTunnelSession`：其 `url`，以及停止子进程（SIGTERM、宽限、SIGKILL）、等待退出并移除会话级配置的 `close()`。会话以 `remote-tunnel/state` 事件报告 `open`（含 URL）、`ended`（子进程退出）或 `failed`（尝试预算耗尽；`open()` 以相同消息拒绝）。会话 `ended` 后 `url` 仍可读但已失效。

配置 `{enabled, download: 'allow'|'deny'|'system', binaryPath?, mode: 'quick'|'named', name?, hostname?}`：`allow` 首次使用时把固定版本的产物下载到 `$DSH_HOME/bin`（macOS tgz 通过系统 tar 解包），`deny` 要求提供已存在的 `binaryPath`，`system` 从 PATH 运行 `cloudflared`。快速模式（默认）无需 Cloudflare 账号，每次会话分配随机主机名；named 模式运行已注册的隧道并挂到稳定的 `hostname`，因此重启后 URL 不变，且要求同时提供 `name`（`cloudflared tunnel create` 得到的隧道名或 UUID）与 `hostname`（裸 DNS 名；会话 URL 为 `https://<hostname>`）。错误配置在加载期即失败：named 缺 `name`/`hostname`、非 named 模式却设置了 `name`/`hostname`、`hostname` 不是裸 DNS 名、`deny` 下缺少 `binaryPath`。下载内容与固定哈希不符时大声失败且不留残余。`enabled` 为 false 或端口非整数/越界时 `open()` 拒绝执行。子进程从经过清洗的父环境启动（不含凭据形状或 `DSH_*` 的名称），但仍携带 `HOME`，因此 named 模式能找到 `~/.cloudflared/{cert.pem,<tunnel>.json}`。

named 模式需要先在部署所属的 Cloudflare 账号下一次性注册隧道才能运行：`cloudflared tunnel login`（浏览器 OAuth 写入 `~/.cloudflared/cert.pem`）、`cloudflared tunnel create <name>`、`cloudflared tunnel route dns <name> <hostname>`，均用固定二进制（或任意匹配的 `cloudflared`）。未执行 `route dns` 时隧道能注册但浏览器会 404，直到 CNAME 记录存在。

重启策略属于消费者：`ended` 后由 [`dsh-remote-access`](../remote-access/README.zh.md) 重新开启会话。

## 目录

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

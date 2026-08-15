# @deepseek-ai/dsh-remote-tunnel

[English](README.md) | 中文

远程隧道能力：默认导出的 `RemoteTunnel` Service（`ctx.remoteTunnel`）及其 cloudflared 快速隧道 provider。`open(port)` 以 `tunnel --url http://127.0.0.1:<port> --no-autoupdate` 启动固定版本（`2026.8.1`，按官方发布校验和逐平台验证 SHA-256）的 `cloudflared`，在有界的 stdout/stderr 窗口内扫描 `https://<slug>.trycloudflare.com` URL（真实 cloudflared 把横幅日志写到 stderr），带退避地重试启动尝试，最终解析出 `RemoteTunnelSession`：其 `url`，以及停止子进程（SIGTERM、宽限、SIGKILL）并等待退出的 `close()`。会话以 `remote-tunnel/state` 事件报告 `open`（含 URL）、`ended`（子进程退出）或 `failed`（尝试预算耗尽；`open()` 以相同消息拒绝）。会话 `ended` 后 `url` 仍可读但已失效。

配置 `{enabled, download: 'allow'|'deny'|'system', binaryPath?}`：`allow` 首次使用时把固定版本的产物下载到 `$DSH_HOME/bin`（macOS tgz 通过系统 tar 解包），`deny` 要求提供已存在的 `binaryPath`，`system` 从 PATH 运行 `cloudflared`。错误配置在加载期即失败（`deny` 下缺少 `binaryPath`）；下载内容与固定哈希不符时大声失败且不留残余。`enabled` 为 false 或端口非整数/越界时 `open()` 拒绝执行。子进程从经过清洗的父环境启动（不含凭据形状或 `DSH_*` 的名称）。

重启策略属于消费者：`ended` 后由 [`dsh-remote-access`](../remote-access/README.md) 重新开启会话。

## Model Experience

None, as the package owns tunnel transport only; no URL, ticket, or cookie reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **单一 provider** — 目前只有 cloudflared 快速隧道一种后端；Service 即未来 frp/Tailscale provider 可替换的接缝，但在第二个 provider 出现前不引入注册表。
- **临时、测试级 URL** — TryCloudflare 每次会话分配随机子域名，Cloudflare 将快速隧道定位为测试用途；需要固定域名或 SLA 的部署应使用命名隧道或其他 provider。
- **安装需一次联网** — `download: allow` 首次使用时从 GitHub 拉取固定版本；离线主机请使用 `system` 或 `binaryPath`。


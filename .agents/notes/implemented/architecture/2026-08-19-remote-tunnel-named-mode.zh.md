# Agent Note: remote-tunnel named 模式 —— 稳定主机名，重启不再换 URL、手机保持配对

Status: implemented

[English](2026-08-19-remote-tunnel-named-mode.md) | 中文

## Problem

`dsh web --remote` 以 **快速模式**（`tunnel --url … --no-autoupdate`）运行 cloudflared，**每次会话**都会分配随机的 `*.trycloudflare.com` slug。remote-access 的配对 cookie 是 **host-only**（无 `Domain` 属性），绑定到具体的 slug 源。于是每次开发重启都会轮换 URL，手机的 cookie 不再匹配，每次重启都必须重新扫码、重新配对——把五秒的重启变成一次重新配对仪式。

## Decision

**给 `dsh-remote-tunnel` 增加 `named` 模式：运行预先注册的 Cloudflare 隧道，挂到稳定主机名上，使 URL 跨重启保持不变、30 天配对 cookie 持续生效。** shipped patch 仍以 `mode: quick` 为默认；运维按部署需要，在 web profile patch（`~/.dsh/profiles/web/cordis.patch.yml`）里 overlay `mode: named` 以及 `name`、`hostname` 来选择稳定性。

- **Config**：`mode: 'quick' | 'named'`（默认 `quick`）、`name?: string`、`hostname?: string`。错误配置在加载期即失败（构造器内）：named 缺 `name` 或 `hostname`、非 named 模式却设置了 `name`/`hostname`（静默丢弃 `hostname` 正是本功能要防的坑）、`hostname` 不是裸 DNS 名（≥2 个 label，无 scheme/路径/端口/空白/尾点，≤253 字符），以及既有的 `deny` 下缺 `binaryPath` 规则。
- **Session spec**：`open()` 推导出 `{ mode: 'quick' } | { mode: 'named'; name; hostname }`，并把 `hostname` 归一化为小写使会话 URL 规范。named 模式下 `CloudflaredSession` 会写入一份会话级 ingress 配置（`tunnel: <name>`，一条从 `<hostname>` 到 `http://127.0.0.1:<port>` 的 ingress 规则，以及 `http_status:404` 兜底规则），并以 `tunnel --config <file> --no-autoupdate run` 派生子进程——`tunnel run` 不接受 `--url`，所以 ingress 由配置文件承载——不再扫描 `*.trycloudflare.com` URL，而是等子进程在 stderr 打印 `registered tunnel connection` 标记后解析出 `https://<hostname>`。会话结束时移除该配置目录。超时、就绪前退出、`watchExit`/`close` 与退避均与模式无关；只有就绪谓词与超时/退出文案不同。
- **一次性运维配置**：`cloudflared tunnel login`（浏览器 OAuth → `~/.cloudflared/cert.pem`）、`cloudflared tunnel create <name>`、`cloudflared tunnel route dns <name> <hostname>`。子进程继承清洗后的父环境，其中仍携带 `HOME`，因此 named 模式能找到 `~/.cloudflared/{cert.pem,<tunnel>.json}`。全程使用 `$DSH_HOME/bin` 下的固定版本二进制。

## Consequences

快速模式仍是 shipped 默认——无需账号、每次会话随机域名、重启需重新配对。named 模式要求 Cloudflare 账号 + 域名与一次性注册；未执行 `route dns` 时隧道能注册但浏览器 404，直到 CNAME 存在（`open()` 时不可检测，已在文档注明）。remote-access 的重连循环未改动：`open()` 每次尝试都从 config 重新推导会话 URL，因此 named 隧道下 URL 恒定、手机保持 cookie。两个 README（remote-tunnel 与 remote-access）均已更新："cookies survive a hostname change" 对 host-only cookie 是错的，现改为依赖模式。

## Alternatives considered

- **固定快速隧道的 slug** —— TryCloudflare 每次都分配全新随机子域名，不存在 slug 固定机制，URL 轮换是快速模式的结构性特征。只有注册过的（named）隧道才拥有稳定主机名。
- **把配对 cookie 抬升为 `Domain=` cookie** —— 构造上就是跨源（每次重启是不同的子域名），而且放在 `*.trycloudflare.com`（或 Cloudflare 路由的任何后缀）上的全域 cookie 会让该后缀下任意 slug 读取本应绑定单一源的配对——host-only 绑定正是设计要点。
- **文档化重新配对仪式** —— 保留了核心摩擦；在稳定主机名模式实现成本很低的情况下被否决。

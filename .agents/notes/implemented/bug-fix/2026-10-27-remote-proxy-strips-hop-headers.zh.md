# Agent Note：远程代理剥除前面某一跳盖下的转发头

Status: implemented

[English](2026-10-27-remote-proxy-strips-hop-headers.md) | 中文

## 问题

已配对设备能打开 Web GUI，但建在共用宿主栅栏上的设置区答 `{"ok":false,"error":"forbidden: loopback-only"}` 403——同一路由在本机答 200。在线上宿主复现：`GET /api/dsh-usage/overview` 直连 3080 是 200、经配对代理的 loopback 端口是 403；把同一请求直连 3080 并加上 `CF-Connecting-IP` 或 `X-Forwarded-For` 同样是 403，从而把原因锁定在某个头而不是闸门。

`createRemoteProxy` 归一化了 Host、浏览器信任标记（`origin`、`sec-fetch-*`）和它自己的 `x-dsh-proxied` 标记，其余头一律转发。Cloudflare 隧道会在代理收到的请求上盖 `CF-Connecting-IP`（边缘还可能盖 `X-Forwarded-For`、`X-Real-IP`），于是转发的请求带着转发头。宿主插件里的共用栅栏——`dsh-web-shared/host/loopback.ts` 中的 `isProxiedRequest`，由 `isLoopbackRequest` 调用——把任何转发头读作「中间有代理」，直接否决 loopback 分支（issue #1906）。只按 loopback 把关的路由（`dsh-usage`、`dsh-ssh`、`dsh-update`、`session-archive`、task-board）因此拒绝每一个隧道请求，无论配对 cookie 是否有效；同一次运行里 `/git/api/repos` 本机 405、经代理 403。带配对判断的路由掩盖了这个缺陷，因为它们的第二条放行路径（`remoteWebUiPairing.isPairedDevice`）本来就会放行。

## 决定

`packages/remote/remote-access/src/proxy.ts` 的 `FORWARDING_HEADERS` 列出 `forwarded`、`x-forwarded-for`、`x-forwarded-host`、`x-forwarded-proto`、`x-real-ip`、`true-client-ip`、`cf-connecting-ip`；转发时与 Host、浏览器信任头一起丢弃，于是主服务看到的是与桌面端相同的 loopback 形状请求，外加 `x-dsh-proxied: 1`。代理仍是唯一的公网信任边界，也是下游消费者唯一可读的转发信号：需要区分隧道流量的插件读标记，绝不读边缘头。下游没有任何地方拿这些头做决定——配对失败预算的可替换键是调用方传入的选项，不是读头——所以没有行为依赖它们抵达。

隧道边缘不是唯一生产者：代理之前的任何一跳都会盖这些头，它们的值描述那一跳，而不是浏览器发给本进程的请求。

## 验证

- [`proxy.spec.ts`](../../../../packages/remote/remote-access/tests/proxy.spec.ts) 把 `CF-Connecting-IP` 与 `X-Forwarded-For` 送过代理，断言目标端两者都收不到，而 `x-dsh-proxied` 仍以 `1` 抵达。
- 改动前的线上宿主实测：直连 3080 → 200，代理端口 → 403，直连 3080 加 `CF-Connecting-IP` → 403。
- 对中继单独跑转发：`cf-connecting-ip`、`x-forwarded-for`、`x-real-ip`、`x-forwarded-host`、`forwarded` 全部以 `null` 抵达；`x-dsh-proxied` 为 `1`。

## 备选方案

**让每个插件栅栏在配对 cookie 有效时接受转发头。** 本仓库之外的每个插件都带着自己的一份栅栏生成副本；副本会漂移，而且栅栏的规则（「中间有代理，所以这不是桌面端」）依然成立——不成立的是「主服务本来就应该看到边缘头」。否。

**在代理里透传一个可信代理开关。** 一个逐插件设置要在五个包里打开才能修一个症状，而这个开关是给「在宿主前面自建反代」的运维用的，不是给宿主自己的中继用的。否。


## 后续影响

已配对浏览器现在经隧道可达每一条按 loopback 把关的插件路由，与桌面端可达范围一致；配对 cookie 仍是唯一凭据，代理仍是唯一公网边界。想知道请求是否经隧道抵达的插件读 `x-dsh-proxied`；拿边缘头做这个判断已不再可能，将来需要访客公网地址的消费者必须显式传递，而不是继承某一跳的头。

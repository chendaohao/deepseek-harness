# Agent Note：远程设备 30 天滑动窗口与围栏 cookie 的每日续期

Status: implemented

[English](2026-09-08-sliding-remote-cookie-renewal.md) | 中文

## Problem

2026-08-18 的可撤销设备模型重构把配对闸门的滑动续期弄丢了。`v2` cookie 在配对时内嵌过期日且永不续期：手机扫码一次后，无论用得多勤，恰好在 30 天后失效——与期望行为（每天使用即重置 30 天窗口，恢复 2026-08-16 移动端 P1/P2 延续工作的 [remote-device-bindings 设计]）正好相反。桌面面板也看不到剩余有效期，而第二层围栏——`/api` 浏览器会话 cookie——有同样的固定寿命缺陷：它的 30 天 `Max-Age` 从 launch-token 访问起算，就算修好闸门，长期使用的配对设备也会在 30 天后撞上 connection 围栏的 401。

## Decision

**过期由注册表拥有，每次使用都滑动；cookie 自身不带过期，按 UTC 日节奏续期。**

- **Cookie v3**（`remote-access/secret.ts`）：值为 `v3.<deviceId>.<mac>`——内嵌过期日移除，铸出的 cookie 自身永不过期。HMAC 上下文从 `v2:` 改为 `v3:`，一次性作废全部旧 cookie（pre-release 立场：不做兼容）；本次变更后已配对设备需重新扫码一次。
- **滑动窗口**（`remote-access/devices.ts`）：`touch` 返回 `{admitted, dayRolled}`。放行即刷新 `lastSeen`；`now - lastSeen >= 30 天` 删除绑定（自动解绑）并拒绝。保留 5 秒的存活通知节流，但跨 UTC 日必定推进 `lastSeen`，续期节奏不会因此饿死。
- **每日 cookie 续期**（`remote-access/policy.ts`）：`authorize` 返回 `{admitted, cookieRefresh}`；每个 UTC 日的首个放行请求会以全新 30 天 `Max-Age` 重发所呈 cookie。代理把该 `Set-Cookie` 合并到转发响应头（追加在目标自身 cookie 之后；node 保证数组形态）。升级握手没有响应头可挂，跨日的升级只滑动注册表窗口，续期由下一个普通请求承载——与原设计一致的既述语义。
- **围栏 cookie 同样续期**（`client-connection/browser-auth.ts`）：`authenticate` 校验所呈 cookie，当 UTC 日相对 `issuedAt` 跨天时铸造全新满寿命 cookie（新 `issuedAt`/`expiresAt`，重新签名）。`HostConnectionHandle.requestRejection` 增加可选 `appendHeader` 回调——HTTP 路由（connection 与 rpc-host 两处 `/api` 注册、open-in-app）附加续期；gateway 的 mux 升级继续不传。被拒或 token 交换请求不产生续期，因此该头只出现在已认证的响应上。
- **面板显示有效期**：控制面与 `remote/devices/change` 现在携带 `DeviceView`（`expiresAt = lastSeen + 30 天`），面板在在线/离线徽标旁渲染 `有效期 {days} 天` / `{days}d left`。注册表持久化的 `DeviceRecord` 形状不变，旧 roster 文件照常加载。

## Alternatives considered

- **每个放行请求都重发 cookie**——否决：Set-Cookie 会挂在每个转发响应上却毫无增益；按天节奏把过期时滞限制在 24–48 小时内，30 天窗口完全容忍。
- **只滑围栏 cookie、不动闸门**（或反之）——否决：两道围栏绑定的是同一个浏览器会话；只续其一，手机仍会在另一道的 30 天节点撞上 401。
- **把续期后的过期日重新嵌进 v2 形状**——否决：跨日请求时铸造新值更简单，且让 `verifyCookie` 保持与时间无关。

## Consequences

- 每天使用的配对手机永不重新配对；面板倒计时保持 30，仅在真正闲置时下降。
- 本次部署后每台设备的旧 v2 cookie 立即失效；补救是重新扫码（或 `--remote-reset` 干脆重来）。roster 本身保留。
- 升级路径不承载续期意味着只跨天开 WebSocket 流的设备窗口会滑动（经 `touch`）但浏览器 `Max-Age` 不延长；任何普通 HTTP 请求（应用壳、`/api` 调用）都会携带续期，实际使用中浏览器 cookie 始终领先注册表窗口。

## Verification

`secret.spec.ts` 覆盖 v3 往返与拒绝矩阵（过期用例已不存在）。`policy.spec.ts` 断言同日判定不带续期、跨日判定原样回显 `Set-Cookie`、闲置越过滑动窗口的设备自动解绑。`devices.spec.ts` 的 roster/持久化覆盖穿过新的 `TouchResult`。`proxy.spec.ts` 的全部 stub policy 走 `AuthorizeResult` 形状。connection 的 `browser-auth` 与 `node-half` 规格覆盖围栏续期（录制器 stub 增加 `appendHeader`），面板规格断言倒计时渲染。无 recorded-session 快照变更：配对闸门与围栏行为都在无密钥 harness 的 loopback 回放路径之后。

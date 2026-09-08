---
name: dsh-web-ship-ui-change
description: Use when a client UI change in deepseek-harness does not appear on the phone or browser after editing packages/client/* code — rebuilds the right artifact chain (tsc client face, tsdown lib/client.js, vite dist), restarts the running dsh web server, and verifies the served bundle actually carries the change via the /plugins combo route.
---

# Ship a dsh web UI change to a live device

Use this skill when a Web client edit (packages/client/*, packages/host/* client faces) "doesn't show up" on the phone or desktop browser, or before claiming a UI change works on a live `dsh web` deployment. It encodes the artifact chain verified on 2026-09-08: `pnpm build` output flows to the browser through **two different channels**, and picking the wrong one produces a green build with a stale page.

## Step 0: identify which channel serves your change

The browser loads workspace client code through exactly one of:

1. **Runtime plugin bundles** (`lib/client.js` per package) — every `dsh.client` roster row (`packages/bundle/web-app/cordis.patch.yml` browser section): ui-remote, ui-settings*, ui-chat, ui-conversation, connection, locale, etc. The node half reads the package's `./client` export (`lib/client.js`) at activation, caches the bytes in the module table, and serves them at `/plugins/<package-name>/client.js` (combo form `/plugins/??a/client.js,b/client.js&rev=…`). **A running server never re-reads these bytes; restart is mandatory after rebuild.**
2. **The vite dist** (`apps/web/dist`) — only the shell graph that `apps/web` imports statically (the boot shell, vendor chunks). `pnpm run build:web` rewrites it; the server serves it straight from disk, so a restart is optional here.

Most panel/feature edits are channel 1. If unsure, grep the package's `package.json` for a `"./client"` export — its presence means channel 1.

## Step 1: rebuild the client face

```sh
pnpm run build:lib:client   # tsc -b tsconfig.client.json + tsdown (client face)
```

Then **verify your package actually emitted**. The workspace log prints one `config file:` line per package but a package can silently produce nothing (see the nested-array trap below). Confirm the two output lines exist:

```sh
pnpm run build:lib:client 2>&1 | grep "dsh-client-ui-remote"
# expect BOTH:  [@deepseek-ai/dsh-client-ui-remote] ... (node half)
#           AND [@deepseek-ai/dsh-client-ui-remote/client] ... (browser half)
grep -c "<your-new-string>" packages/client/<pkg>/lib/client.js   # new code present
```

**The nested-array trap**: a package tsdown config factory must return the shared preset's array flat — `return clientBundle(...)({ env })`, never `[clientBundle(...)({ env })]` (nested `UserConfig[][]` makes the runner skip the package silently, no error). Symptom: green build, missing `[pkg]/client]` log line, stale `lib/client.js` mtime. See the Agent Note `.agents/notes/implemented/process/2026-09-08-tsdown-factory-nested-array.md`.

## Step 2: restart the server (channel 1 only)

```sh
# find and stop the old process tree (pnpm wrapper + tsx child + doctor supervisor)
ps aux | grep -E "dsh web|bin.ts web" | grep -v grep
kill <pids>; pkill -f "dsh-doctor.*supervisor"; pkill -f "cloudflared.*dsh-remote-tunnel"
sleep 2; ss -tlnp | grep 3080   # port released

# restart detached; the log line "dsh web remote: https://…/pair/<token>" is the health signal
nohup pnpm dsh web --remote --port 3080 > /tmp/dsh-web-remote.log 2>&1 &
sleep 12 && grep -aE "dsh web remote|[eE]rror" /tmp/dsh-web-remote.log
```

Named tunnels (`mode: named`) keep the hostname across restarts; the printed pair URL carries a fresh one-time pairing token each boot.

## Step 3: verify the served bytes, not the build

`/plugins` answers 401 without the fence cookie — authenticate once with the launch token from the boot log, then fetch the bundle the way the browser does:

```sh
TOKEN_URL=$(grep -ao 'http://127.0.0.1:3080/?token=[A-Za-z0-9]*' /tmp/dsh-web-remote.log | head -1)
curl -s -c /tmp/ck.txt -L "$TOKEN_URL" -o /dev/null
curl -s -b /tmp/ck.txt "http://127.0.0.1:3080/plugins/??@deepseek-ai/dsh-client-ui-remote/client.js&rev=IGNORED" \
  -o /tmp/served.js -w "%{http_code} %{size_download}\n"
grep -c "<your-new-string>" /tmp/served.js   # 1+ means the phone will get it
```

The rev query value is validated against the advertised graph; if the exact rev is needed, pull it from the served index (`curl -b /tmp/ck.txt http://127.0.0.1:3080/ | grep -o 'client-ui-remote/client.js&rev=[^&]*'`) or just fetch the full startup combo URL printed in the boot graph. `404` with a zero size means wrong plugin id (use the full `@deepseek-ai/dsh-client-ui-remote` spelling, not the short row id) or an unadvertised rev.

## Mobile-specific notes

- After a cookie-semantics change (e.g. HMAC context rotation), all paired devices need **one re-scan** of the panel QR; the roster itself survives restarts.
- The paired-device panel renders `有效期 {days} 天` from `DeviceView.expiresAt`; the sliding renewal refreshes `Max-Age` on the first admitted request of each UTC day (`remote-access` gate) and the fence cookie likewise (`client-connection`).
- `pnpm run dev:web` (watch mode) rewrites `lib/client.js` on source edits and the server's HMR chain reloads plugins without restart — use it for iterative UI work; the manual chain above is for verification and one-shot deploys. Never run `dev:web` concurrently with `pnpm run build` (same output trees).

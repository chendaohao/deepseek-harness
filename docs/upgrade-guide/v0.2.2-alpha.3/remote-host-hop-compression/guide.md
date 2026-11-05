---
kind: upgrade-guide
description: "The remote-access proxy stops compressing its Host-facing WebSocket hop, so remote-client traffic over a bound interface address is no longer compressed on that leg."
---

# Remote-access compresses only the remote-facing WebSocket hop

English | [中文](guide.zh.md)

## Change

The `remote-access` proxy used to negotiate `permessage-deflate` independently on both of its WebSocket relay hops. It now negotiates the extension only on the hop that faces the remote client and declines it on the dial to the local Web server. `websocketCompression: 'deflate'` therefore means "compress the remote-facing hop", not "compress both hops"; `'none'` still disables compression entirely.

A large downlink payload used to be deflated by the Gateway, inflated by the proxy, and deflated again for the remote client. Measured over loopback with a 1.4 MiB history-shaped opening frame, 20 answer frames of about 6.5 KB, and a below-threshold control group, the change cut whole-path process CPU by roughly 23% while the bytes the remote client received were identical.

## Migration

1. Nothing changes for a deployment that keeps the default `127.0.0.1` bind: the Host-facing hop never leaves the machine, so no bandwidth was at stake.
2. A deployment started with `dsh web --host <interface address>` now sends the Host-facing hop in plaintext across that interface. If that leg crosses a network you do not control, bind the loopback address and expose the Web GUI through the remote tunnel instead of the interface. There is no per-hop compression switch: the setting controls the remote-facing hop only.
3. No configuration key, persisted value, wire format, or Session field changed. `websocketCompression: 'none' | 'deflate'` keeps both its name and its accepted values.

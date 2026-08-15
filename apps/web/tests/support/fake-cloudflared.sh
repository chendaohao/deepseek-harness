#!/bin/sh
# Keyless remote-access fixture: plays cloudflared for dsh-remote-tunnel.
# Prints a fixed trycloudflare URL line, then forwards 127.0.0.1:FAKE_PORT
# to the proxy port handed in as the --url argument.
#   $1 tunnel   $2 --url   $3 http://127.0.0.1:<proxyPort>   $4 --no-autoupdate
echo '2026-08-14T00:00:00Z INF Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):'
echo 'https://fake-slug.trycloudflare.com'
exec node "$REMOTE_FIXTURE_FORWARDER" "${3##*:}"

// Keyless remote-access fixture: an HTTPS listener (self-signed test cert)
// that relays the decrypted HTTP and WebSocket traffic to the remote-access
// proxy port, so the browser drives the pairing flow through a fake
// non-loopback Host over a real secure context, without a real tunnel. A
// separate plain-HTTP control listener counts upgrades and can tear every live
// WebSocket pair, letting tests simulate a tunnel-side drop and observe the
// browser's automatic reconnect.
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'

const target = Number(process.argv[2])
if (!Number.isInteger(target) || target < 1) {
  console.error('fake-cloudflared-forwarder: missing proxy port')
  process.exit(1)
}
const listenPort = Number(process.env.REMOTE_FIXTURE_PORT ?? 39990)

const server = createHttpsServer({
  key: readFileSync(new URL('fake-tunnel-key.pem', import.meta.url)),
  cert: readFileSync(new URL('fake-tunnel-cert.pem', import.meta.url)),
}, (req, res) => {
  const proxyReq = httpRequest({
    host: '127.0.0.1',
    port: target,
    path: req.url,
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
    proxyRes.pipe(res)
  })
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502)
      res.end('bad gateway')
    } else {
      res.destroy()
    }
  })
  req.pipe(proxyReq)
})

let upgrades = 0
const pairs = new Set()

server.on('upgrade', (req, socket, head) => {
  upgrades++
  const upstream = connect(target, '127.0.0.1')
  const pair = { socket, upstream }
  pairs.add(pair)
  const drop = () => { pairs.delete(pair) }
  socket.on('close', drop)
  upstream.on('close', drop)
  upstream.on('connect', () => {
    upstream.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n')
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      upstream.write(name + ': ' + (Array.isArray(value) ? value.join(', ') : value) + '\r\n')
    }
    upstream.write('\r\n')
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  const fail = () => { socket.destroy(); upstream.destroy() }
  upstream.on('error', fail)
  socket.on('error', () => { upstream.destroy() })
})

// Control listener: POST /kill tears every live WebSocket pair (tunnel-side
// drop simulation), GET /stats reports the cumulative upgrade count.
const controlPort = Number(process.env.REMOTE_FIXTURE_CONTROL_PORT ?? 39991)
createHttpServer((req, res) => {
  if (req.method === 'POST' && req.url === '/kill') {
    for (const { socket, upstream } of [...pairs]) {
      socket.destroy()
      upstream.destroy()
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ killed: pairs.size }))
    return
  }
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ upgrades }))
    return
  }
  res.writeHead(404)
  res.end('not found')
}).listen(controlPort, '127.0.0.1')

server.listen(listenPort, '127.0.0.1')


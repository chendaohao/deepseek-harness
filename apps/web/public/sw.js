/**
 * DSH web shell service worker: offline-capable cache for the app shell and
 * plugin bundles, network-first for the index document.
 *
 * Strategy per resource:
 * - / and SPA routes (GET, navigation): network-first with cache fallback —
 *   the boot manifest changes with the plugin set, so the fresh copy wins,
 *   and the cached one keeps the app usable offline.
 * - /assets/* (Vite content-addressed) and /plugins/*?rev=* (content-hashed
 *   bundle URLs): cache-first — the URL embeds the content digest, so a
 *   cache hit is always the right body; failures fall through to the network.
 * - /api/* and /plugins/events: never cached (state and streams stay live).
 *
 * The worker itself is served with no-cache and registered with
 * updateViaCache: 'none', so a deployed update replaces it on the next visit;
 * the install step then precaches the current shell.
 */
const VERSION = 'dsh-shell-v1'
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION)
    await cache.addAll(PRECACHE)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== VERSION) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/plugins/events') return
  const isNavigation = request.mode === 'navigate'
  const isContentAddressed = url.pathname.startsWith('/assets/')
    || (url.pathname.startsWith('/plugins/') && url.pathname.endsWith('/client.js') && url.searchParams.has('rev'))
  if (isNavigation) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request)
        const cache = await caches.open(VERSION)
        cache.put('/index.html', fresh.clone())
        return fresh
      } catch {
        const cached = await caches.match('/index.html')
        if (cached !== undefined) return cached
        return Response.error()
      }
    })())
    return
  }
  if (isContentAddressed) {
    event.respondWith((async () => {
      const cached = await caches.match(request)
      if (cached !== undefined) return cached
      const fresh = await fetch(request)
      if (fresh.ok) {
        const cache = await caches.open(VERSION)
        cache.put(request, fresh.clone())
      }
      return fresh
    })())
  }
})

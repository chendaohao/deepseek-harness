/** Browser entry for the Web client. */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
// Offline shell + bundle cache. Only on http(s) origins — Electron's file://
// pages have no service-worker scope and skip registration by design.
// updateViaCache: 'none' makes update checks bypass the HTTP cache so a
// deployed worker takes over on the next visit (the server also serves the
// script no-cache, so the initial registration revalidates too).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch((error: unknown) => {
    console.warn('web app: service worker registration failed', error)
  })
}
void new AppWebEntry(el).run()

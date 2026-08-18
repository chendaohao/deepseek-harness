/**
 * Mobile surface entry: the standalone phone UI served at /m. Boots its own
 * React tree (no main-UI module loader), talks to the host over the shared
 * /api transport with the paired-device cookie, and renders a deliberately
 * thin three-level surface: workspaces (landing) → sessions (list + search +
 * create) → chat (history + live stream + prompt + model picker + rename).
 */

import { createRoot } from 'react-dom/client'
import { App } from './views/App.tsx'
import { mobileCss } from './mobile-styles.ts'
import { initMobileTheme } from './theme.ts'

// Apply the persisted (or default light) theme before first paint, so the
// page never flashes the wrong palette.
initMobileTheme()

// Inject the standalone stylesheet (the page has no shell to load it for us).
const style = document.createElement('style')
style.dataset.plugin = 'dsh-client-ui-remote/mobile'
style.textContent = mobileCss
document.head.appendChild(style)

createRoot(document.body).render(<App />)

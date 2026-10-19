/**
 * Phone adaptation layer, browser half. It contributes no slot, no control, and
 * no copy: the shipped GUI already owns the sidebar toggle (the rail button) and
 * the narrow floating-sidebar geometry, so this package only supplies the
 * touch sizing a desktop stylesheet never states, and the swipe phone users
 * reach for.
 *
 * Everything installs through `ctx.effect`, so disabling the row removes the
 * stylesheet, the host attribute, and every listener with the plugin fiber.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the `layout` service merge (ctx.layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { FORCE_DESKTOP_KEY, isPhoneDevice } from './device.ts'
import { installSidebarGestures } from './gestures.ts'
import touchCss from './touch.css?inline'

/**
 * Attribute marking the document as running the adaptation layer. Every rule in
 * the touch stylesheet is scoped to it, so the document-wide sheet stays inert
 * on a desktop page.
 */
const LAYER_ATTRIBUTE = 'data-dsh-mobile-layer'

/** Required services: the panel controller the swipe drives. */
export const inject = ['layout']

/**
 * Read the opt-out flag, treating an unavailable session store as unset. Access
 * throws rather than returning null in a blocked-storage privacy mode.
 * @returns whether this tab asked for the desktop layout.
 */
function forceDesktopRequested(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(FORCE_DESKTOP_KEY) === '1'
  } catch (error) {
    // Storage is denied by policy, not misconfigured: the layer stays on.
    void error
    return false
  }
}

/**
 * Whether the narrow sidebar is expanded. The layout controller publishes only
 * the selected panel, but the frame stamps the narrow floating-sidebar state on
 * its own element (`data-sidebar-overlay`, set while the sidebar is expanded on
 * a narrow frame) — that attribute is the current contract for this fact, and
 * reading it keeps this package off a new layout-service method.
 * @returns whether the sidebar is expanded over the center.
 */
function isSidebarExpanded(): boolean {
  return document.querySelector('[data-sidebar-overlay]') !== null
}

/**
 * Install the phone adaptation layer for the plugin lifetime.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  if (typeof document === 'undefined') return
  if (!isPhoneDevice()) return
  // An explicit opt-out for this tab: a user who wants the desktop layout on a
  // phone (a large tablet, an external display) sets the flag and reloads.
  if (forceDesktopRequested()) return

  const root = document.documentElement
  ctx.effect(() => {
    root.setAttribute(LAYER_ATTRIBUTE, '')
    return () => { root.removeAttribute(LAYER_ATTRIBUTE) }
  }, 'ui-mobile: layer attribute')

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@deepseek-ai/dsh-client-ui-mobile'
    tag.dataset.pluginCss = '@deepseek-ai/dsh-client-ui-mobile/touch.css'
    tag.textContent = touchCss
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'ui-mobile: touch stylesheet')

  ctx.effect(
    () => installSidebarGestures({
      isSidebarExpanded,
      toggleSidebar: () => { ctx.layout.toggleSidebar() },
    }),
    'ui-mobile: sidebar gestures',
  )
}

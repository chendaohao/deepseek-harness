/**
 * System-notification firing on Session completion edges.
 *
 * Subscribes to the Session UI status snapshot and posts one system
 * notification per Session whose `running` flips true → false while the
 * document is hidden and the preference is enabled. The document-hidden gate
 * keeps an attended foreground tab silent; the per-Session tag collapses
 * repeats, and a click focuses the window and opens the Session.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionStatusSnapshot } from './index.ts'

/** Document visibility and notification permission, browser-shaped for tests. */
export interface NotifyEnvironment {
  /** Whether the document is hidden from the user. */
  isHidden(): boolean
  /** Current Notification.permission, or absence on unsupported platforms. */
  permission(): NotificationPermission | undefined
  /** Ask the user for notification permission.
   * @returns the resolved permission. */
  requestPermission(): Promise<NotificationPermission | undefined>
  /** Post one system notification.
   * @param title - notification title.
   * @param options - body, tag, and the click handler. */
  notify(title: string, options: { body: string; tag: string; onClick(): void }): void
  /** Focus the window (a notification click target). */
  focus(): void
}

/**
 * The browser environment, absent on platforms without Notification.
 * @returns the environment, or undefined when the globals are unavailable.
 */
export function browserNotifyEnvironment(): NotifyEnvironment | undefined {
  const globals = globalThis as { document?: Document; Notification?: typeof Notification }
  if (globals.document === undefined || globals.Notification === undefined) return undefined
  return {
    isHidden: () => document.hidden,
    permission: () => Notification.permission,
    requestPermission: async () => {
      const result = await Notification.requestPermission()
      return result
    },
    notify: (title, options) => {
      const posted = new Notification(title, { body: options.body, tag: options.tag })
      posted.onclick = () => { options.onClick() }
    },
    focus: () => { window.focus() },
    // Session opening rides the install-site closure; kept here for the full surface.
  }
}

/** Inputs of {@link installCompletionNotifier}. */
export interface CompletionNotifierInputs {
  /** Session UI status source (running / pending / completionUnread per Session). */
  readonly status: ObservableSnapshot<SessionStatusSnapshot>
  /** Display title lookup for one Session. */
  readonly displayTitle: (sessionId: SessionId) => string
  /** Open one Session in the main view. */
  readonly openSession: (sessionId: SessionId) => void
  /** Localized title template. */
  readonly title: string
  /** Localized body template carrying `{title}`. */
  readonly body: string
}

/**
 * Watch Session running edges and fire notifications while hidden.
 * @param inputs - status source, titles, navigation, and localized copy.
 * @param environment - platform notification surface; undefined disables.
 * @param enabled - live preference: notifications fire only while true.
 * @returns the disposer removing the subscription.
 */
export function installCompletionNotifier(
  inputs: CompletionNotifierInputs,
  environment: NotifyEnvironment | undefined,
  enabled: () => boolean,
): () => void {
  if (environment === undefined) return () => {}
  const runningSeen = new Map<SessionId, boolean>()
  return inputs.status.subscribe(() => {
    if (!enabled() || !environment.isHidden()) {
      // Keep the observed baseline current so a later edge, not this frame, fires.
      for (const [id, status] of inputs.status.getSnapshot()) runningSeen.set(id, status.running === true)
      return
    }
    for (const [id, status] of inputs.status.getSnapshot()) {
      const was = runningSeen.get(id)
      runningSeen.set(id, status.running === true)
      if (was !== true || status.running === true) continue
      if (environment.permission() !== 'granted') continue
      environment.notify(inputs.title, {
        body: inputs.body.replace('{title}', inputs.displayTitle(id)),
        tag: `dsh-session-${id}`,
        onClick: () => {
          environment.focus()
          inputs.openSession(id)
        },
      })
    }
  })
}

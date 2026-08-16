# Agent Note: Web GUI narrow-viewport overlays — sidebar drawer, details overlay, touch hover gate

Status: implemented

English | [中文](2026-08-16-web-gui-narrow-drawer.zh.md)

## Problem

The web GUI is a desktop-first three-column shell. On a phone browser the auto-collapse breakpoint (SIDEBAR_AUTO_COLLAPSE = 1024) reduced the sidebar to a 56px rail, but the manual re-expand (narrowExpanded) squeezed the conversation column to the leftover track: at 393px viewport the center measured 113px, pushing the header utilities and every tool row off-screen right. Two further touch defects compounded it: the details concession chain always auto-closed the details panel below ~1056px so tool-row details were unreachable on a phone, and the session-row HoverCard opened on tap (pointerenter) and could never leave, sticking over the UI at z-100 and swallowing taps (it blocked the drawer scrim, among others). The context-injection source chip also hard-clipped mid-glyph (flex: none in a clipping flex row) and the header title conceded to off-screen utilities.

## Decision

**On narrow viewports the expanded sidebar and the details panel become overlay drawers; hover previews stop opening for coarse pointers; the header and context chips stop clipping.**

- **Sidebar drawer** (`packages/client/ui-layout` AppFrame + module CSS): below the breakpoint, `narrowExpanded` renders the sidebar as a `position: absolute` overlay (z-30, width `min(preference, viewport - 64)`) over a scrim (z-24); the grid keeps the rail track at 0px while open so the center never concedes. Explicit `grid-column` placement keeps the center/details in their tracks now that the scrim and drawer leave the grid flow. Tapping the scrim closes it, and picking a session inside the drawer auto-closes it (a narrow-only effect watching the current Session, so the just-opened conversation is not covered); narrow overlays never render drag handles.
- **Details overlay** (same files): a narrow details preference renders the details column as a right-hand overlay (the close-on-session-switch lifecycle of the [details session lifecycle note](../bug-fix/2026-07-29-web-details-session-lifecycle.md) is untouched) at `min(preference, viewport - 24)` with the same scrim; the concession solver only sees closed preferences in this state, so opening details no longer silently auto-closes it. (The details panel itself is still unreachable from the chat on both platforms — `openDetails` has no caller; that gap predates this change and is tracked separately.)
- **HoverCard touch gate** (`packages/client/ui-primitives`): `onPointerEnter` returns for `pointerType === 'touch'`, so a tap can no longer open a preview card that has no leave event to close it. Mouse and pen behavior is unchanged; jsdom specs dispatch pointerenter without pointerType, so they keep exercising the hover path.
- **Header utilities row** (`packages/client/ui-conversation` ConversationRoot): below 560px the utility cluster moves to its own row (`flex: 0 0 100%` with the title cluster at `flex: 1 1 auto` — a zero basis would let the 100%-basis item share line one and collapse the title to 0px), so the session title keeps the full first line.
- **Context chip** (`ContextInjectionRow`): the producer-name chip becomes shrinkable (`flex: 0 1 auto`) so the ellipsis engages instead of a mid-glyph clip at the disclosure row's overflow edge.

## Alternatives considered

- **Capping the expanded sidebar width instead of overlaying** — rejected: even a 70% cap leaves a ~120px conversation on a 360px phone; a drawer is the standard mobile pattern and the center keeps full width.
- **CSS-only hover suppression** — rejected: the card opens from JS timers; only the pointer-type gate covers all paths including keyboard-emulated enters.
- **Media-query hover suppression (matchMedia '(hover: hover)')** — rejected: jsdom's matchMedia reports false, which would flip all hover-card specs off.

## Consequences

- Mobile conversation now keeps full viewport width in every state; the drawer and details overlays cover the center behind a scrim and close on scrim tap.
- Desktop behavior is unchanged (verified in the live GUI and the AppFrame component specs, which were rewritten for the drawer contract: two narrow-expand tests now assert the drawer and a new test covers the narrow details overlay).
- AppFrame geometry tests keep the old desktop concession assertions untouched.
- Rebuilds required: `@deepseek-ai/dsh-client-ui-layout` and `@deepseek-ai/dsh-client-ui-conversation` bundles (plugin registry re-hashes on the HMR watch), plus the `@deepseek-ai/dsh-web-frontend` shell (ui-primitives is inlined into the shell via the vite alias).
- Still open on mobile: the details panel has no chat entry point (pre-existing), long tool summaries ellipsize without a touch-accessible full text, code blocks scroll horizontally, and the Tooltip primitive has the same sticky-on-tap pattern as HoverCard (lower severity: the next tap dismisses it).
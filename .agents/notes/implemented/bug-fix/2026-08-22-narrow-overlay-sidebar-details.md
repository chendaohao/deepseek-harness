# Agent Note: Narrow-viewport overlays for sidebar/details and hero-row wrap

Status: implemented

English | [中文](2026-08-22-narrow-overlay-sidebar-details.zh.md)

## Problem

Measured on real phone viewports (360/390/412px), the web GUI three-column frame fails mobile input controls three ways:

1. Expanding the sidebar on a narrow viewport squeezes the center column to ~68px — the composer textarea becomes unusable.
2. The details panel cannot open on a phone: the concession chain solves the narrow request down to zero width, so tapping a tool row shows nothing, while the zero-width column still paints a 1px border seam outside the viewport.
3. The blank-session hero row (workspace chip + agent-preset seat + git-graph branch chip) overflows horizontally: the branch chip anchors to the row's painted right edge and extends off-screen.

## Decision

Keep contract-frozen concession geometry for wide desktops; on narrow viewports (< SIDEBAR_AUTO_COLLAPSE = 1024) opened panels stop squeezing the center and float above it as overlays:

- AppFrame renders data-sidebar-overlay / data-details-overlay when narrow and the panel is expanded. The grid keeps the collapsed rail plus the full-width center; the panel lays out absolutely at its contract width (sidebar 280px, details min(100%, 360px)) with a click-away backdrop (data-shell-backdrop). Drag handles are not rendered for narrow overlays.
- DetailsPanel no longer paints its own border-left; the column owns it and data-details-collapsed already removes it, so the seam disappears.
- heroWorkspaceRow gains flex-wrap: wrap with a combined gap.

The git-graph branch chip is plugin-owned (@linxin666/dsh-client-ui-git-graph); the installed 0.2.5 bundle (src + lib/client.js) is patched in place: when the hero row cannot fit the chip, placement falls back to a below row (normal flow under the hero row) instead of absolute-anchoring off-screen. The installed dsh-ssh and dsh-task-board bundles gain a 640px media query raising input font-size to 16px (the iOS focus-zoom threshold), and task-board columns narrow to minmax(170px, 1fr) lanes on phones.

## Alternatives considered

- **Let the sidebar keep squeezing the center at narrow widths, with a smaller composer.** Rejected because 68px of center does not host an input control at all; the overlay restores the full-width composer while keeping the rail tappable.
- **Hide the branch chip when the hero row is full.** Rejected because the branch selector is a primary blank-session control (repository awareness); dropping it on phones silently removes capability. The below-row fallback keeps it visible and reachable.
- **Raise plugin input font sizes unconditionally to 16px.** Rejected because the dense 13px carries the desktop width budget; the 640px media query raises the size only where iOS focus zoom would trigger.

## Consequences

- Width preferences are never rewritten: re-widening still restores drag widths; the existing wide-closed-narrow test now asserts the overlay instead of the squeezed track.
- Plugin changes land in the profile install (~/.dsh/profiles/web) — the deployed surface. The dsh-web-ui family repo checkout on this machine is a different generation (0.1.x) and was not backported.

## Verification

- app-frame.client.spec.tsx: narrow toggle asserts data-sidebar-overlay, width 280, no handles; new cases cover backdrop click-to-close and narrow details overlay open/close. ui-layout + ui-conversation suites pass (528 tests).
- Headless Chromium at 390/412px against the live server: branch chip fully in-viewport, sidebar overlay opens and backdrop closes restoring full composer width, details column zero-width with no seam, SSH and task-board search inputs at 16px.

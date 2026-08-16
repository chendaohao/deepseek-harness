# Agent Note: Touch-primary web devices skip the composer refocus on session switch

Status: implemented

English | [中文](2026-08-16-touch-session-switch-no-focus.zh.md)

## Problem

The composer bar's unlock effect refocuses the textarea on mount and on every session switch. That focus exists for keyboard continuity on fine-pointer devices: after switching sessions the user can type immediately, and the caret reveal keeps long drafts at their end. On a touch-primary device, the same gesture-less focus opens the virtual keyboard — a phone user who only tapped a session in the list suddenly has half the screen covered, and the keyboard also pops on initial page load.

## Decision

The unlock effect in `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` skips the `focus()` when the primary input has no hover capability — `window.matchMedia('(hover: none)').matches`, evaluated once per bar through a ref, the same probe `Tooltip` already uses for coarse-input behavior. The draft-scrollport caret reveal still runs: it moves only the composer's own box, never the transcript, so a long restored draft still ends at its caret. Fine-pointer devices are unchanged, including browsers without `matchMedia` (jsdom), where the probe resolves to fine.

## Alternatives considered

**Skip on `(pointer: coarse)` instead of `(hover: none)`.** `pointer: coarse` matches touch-capable laptops whose primary pointer is a trackpad or mouse; those users keep their keyboard continuity, and focusing there does not force a virtual keyboard up. `hover: none` targets exactly the devices where a gesture-less focus pops one, and it is the probe the codebase already standardizes on for coarse-input UI decisions.

**Skip focus only when the switch was pointer-initiated.** A recent-pointerdown check would preserve refocus for keyboard-driven session switching on hybrid devices, but it adds a second stateful mechanism, and the mount case (page load) still needs the media probe — two mechanisms for one behavior, for a device class (`hover: none` plus a physical keyboard) that already suppresses the on-screen keyboard on its own.

**Focus, then blur immediately.** Blurring after the focus still flashes the keyboard frame on mobile and leaves focus semantics ambiguous for assistive technology; not focusing at all is simpler and observably equivalent for the user.

## Consequences

- A phone user switching sessions no longer gets the keyboard; tapping the box focuses it natively, exactly as the gesture suggests.
- Desktop keyboard continuity is unchanged: session switch still returns focus to the composer with `preventScroll`, and the reveal still positions a long draft's caret.
- A hybrid device in a hover-less state (tablet with no trackpad or keyboard attached) skips the refocus too; attaching one makes `hover: none` stop matching and continuity returns, matching when the platform actually suppresses the on-screen keyboard.
- The behavior is pinned by `input-bar.client.spec.tsx` ("a session switch on a touch-primary device reveals the caret without taking focus"): a stubbed `matchMedia` reports `matches: true`, the session-switch rerender performs the reveal, and the textarea receives no focus.

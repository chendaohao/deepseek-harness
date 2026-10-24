---
description: "Phone adaptation layer for the Web GUI: touch sizing, safe-area insets, and swipe-to-toggle sidebar, applied only to phone-class devices."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-mobile

English | [中文](README.zh.md)

## Summary

The shipped Web GUI is a desktop layout with no portrait, coarse-pointer, or safe-area rule. This package supplies that missing layer: a touch stylesheet raising control targets to the 44px minimum, holding composer inputs at 16px so iOS does not zoom on focus, and padding the composer for the home indicator, plus swipe-to-toggle for the sidebar and a document-scroll reset that keeps the shell pinned to the top of the phone viewport. It contributes no slot, control, or copy; the sidebar trigger and narrow floating geometry exist in `ui-sidebar` and `ui-layout`. The same layer also pins the document's scroll offset to zero: on a phone the browser scrolls the shell itself while its address bar moves or as the page returns from the background, which shifts the whole frame up by that offset. Every rule is scoped to a stamped `data-dsh-mobile-layer` attribute and installed through `ctx.effect`; disabling the row removes the layer with the plugin fiber.

## Table of Contents

- [When the layer applies](#when-the-layer-applies)
- [Selector contract](#selector-contract)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="when-the-layer-applies"></a>
## When the layer applies

The gate is a phone-class device: a touch-primary pointer with no hover capability, with a mobile user-agent fallback for runtimes without `matchMedia`. The `(hover: hover)` check leads so a laptop touchscreen — coarse pointer, but hovering — is excluded; styling such a page for touch would shrink the desktop layout on a device that has a mouse and a keyboard.

Setting `sessionStorage['dsh-remote-force-desktop'] = '1'` and reloading opts one tab out, for a phone driving an external display. A blocked session store reads as unset, so the layer stays on rather than failing the page.

<a id="selector-contract"></a>
## Selector contract

The touch stylesheet is document-wide but reaches components through CSS Modules **local-name suffixes**: the client build compiles modules as `[hash]_[local]` (`packages/client/tsdown.client.ts`), so `[class$="_composerSeat"]` matches that one component's seat without naming a hash. The rule set is small and each selector names a component that owns the behavior:

| Selector | Owning package | Why |
|---|---|---|
| `[class$="_iconButton"]` | `ui-sidebar` | The rail's controls render a 24px glyph; a finger needs 44px |
| `[class$="_composerSeat"]` | `ui-conversation` | Input font size (iOS zoom) and the home-indicator inset |
| `[class$="_centerCol"]` | `ui-layout` | Landscape notch clearance on both side edges |
| `[data-dsh-mobile-layer]` on `html`, `body`, `#root` | `ui-web` (`base.css`) | Shell height follows the dynamic viewport, not the layout viewport |

Renaming one of those local classes is a deliberate act that shows up as a diff in its owning package; this table is the list to re-check when it happens.

## Model Experience

None, as the layer is presentation and device gating only: it assembles no provider request, contributes no prompt, schema, or tool result, and reads no Session state.

#### KV Cache effect

None; the layer never assembles a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Suffix selectors are a convention, not a type-checked contract.** A renamed CSS Modules local class silently drops its rule. The table above is the manual re-check list; nothing in the build fails.
- **The layer styles, it does not re-lay-out.** Narrow geometry, the floating sidebar, and the tap-away backdrop already exist in `ui-layout`; this package does not restate them, so a phone layout change belongs in that package, not here.
- **Enter still submits on a soft keyboard.** The composer's keymap is a frozen pipeline owned by `ui-conversation` (plain Enter submits, Shift+Enter breaks the line), and a phone keyboard has no Shift. Changing that is a framework change, not a plugin one; send stays on the send button.
- **The scroll reset corrects the offset, it does not prevent the browser from setting it.** A scripted reset after `visibilitychange` runs one frame late, so a returning page can paint one frame at the restored offset before it snaps to the top.
- **The device predicate is a deliberate second copy** of the transport's `isPhoneWeb` (`api-gateway`). See the module note in `src/client/device.ts` for why the two are not shared.

<a id="dev-note"></a>
### Invariant ownership

No runtime invariant companion is published: the layer holds no durable state, and its whole effect is removed with the plugin fiber.

### Dev Note

<details>
<summary>Why the gestures are passive</summary>

Scroll safety is the design constraint. Listeners are passive and never call `preventDefault`, so the browser keeps ownership of panning and the gesture only observes. A pointer that travels mostly vertically is abandoned on first movement, so a scroll can never be reinterpreted as a toggle; opening additionally requires the touch to start in the left-edge zone, because a rightward drag from mid-page is far more likely to be a selection or a horizontal scroll.

</details>
# Agent Note: vision tools delegate image-format detection to the attachment store

Status: implemented

English | [中文](2026-08-15-vision-tools-delegate-format-detection-to-store.zh.md)

## Problem

`vision_observe` and `read_image` gated every call on a path-extension allowlist (PNG/JPEG/WebP/GIF) and refused any path without a recognized extension before touching the file, even when the bytes were a valid image. The attachment store's admission already detects the real format by fully decoding the raster (sharp) and is documented as authoritative, so the tool-level gate duplicated a weaker, extension-based check ahead of it. Hash-named attachment-store objects (`~/.dsh/attachments/v1/objects/<sha256-prefix>/<sha256>`) carry no extension, so observing an already-committed image failed with `only accepts PNG/JPEG/WebP/GIF paths` until the file was copied to an extension-bearing name. The deployment `mediaTypes` allowlist was likewise enforced only by the two tools, ahead of the store that owns admission.

## Decision

`SaveImageAttachment.mediaType` is now optional. The store's admission (`inspectMetadata`) fully decodes the bytes, enforces the deployment `mediaTypes` allowlist on the detected type (`IMAGE_TYPE_NOT_ALLOWED`), and only cross-checks a declared type when one is present (`IMAGE_TYPE_MISMATCH` stays for declarers such as the browser upload path). Both tools dropped the extension allowlist and the mediaTypes pre-check: they read the bounded bytes and call `saveImage({ data, name })`, letting the store detect the format. The file's extension never determines admission.

## Alternatives considered

**Tool-side magic-byte sniffing.** Rejected: it duplicates the attachment store's authoritative sharp decode in two tools (or a shared helper), adds a second source of truth for format identity, and still cannot refuse before the read without re-implementing the store's admission.

**Keep the extension gate and add an extension-less escape hatch.** Rejected: a special case for hash-named paths preserves the misdirected gate while adding a second path through it.

## Consequences

Extension-less and mis-extensioned image files now work in both tools (the store detects the real format); non-image files are read up to the byte cap before the store refuses them with `Unsupported or malformed image data.` (previously refused by extension before any I/O — listed as a known limitation). Declared types from callers that still declare (browser uploads) keep the strict cross-check.

The `gen-cordis-api` catalog generator additionally required mapping the `visionBridge` marker service in `SERVICE_WALK_EXEMPTIONS` (missing since the vision bridge landed, so the catalog gate failed); the exemption names `dsh-vision-bridge` as the documentation owner.

Verification: unit coverage pins detected-format admission, allowlist refusal on the detected type, declared-type cross-check retention, extension-independent success in both tools, and non-image refusal; `verify-cordis-api` passes.

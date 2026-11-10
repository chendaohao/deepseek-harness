/** Title text normalization and UTF-8-safe truncation. */

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/** Reject an invalid public text limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

/** Remove controls and produce one trimmed, whitespace-normalized line. */
function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Truncate a string to a UTF-8 byte budget without splitting a Unicode code point.
 * @param input - normalized title text.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns the longest leading code-point prefix within the budget.
 */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  assertPositiveInteger('maxBytes', maxBytes)
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/**
 * Normalize one accepted session title and enforce its UTF-8 byte budget.
 * @param input - untrusted title text.
 * @param maxBytes - positive maximum encoded size.
 * @returns a terminal-safe one-line title, possibly empty after sanitization.
 */
export function normalizeSessionTitle(input: string, maxBytes: number): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd()
}

/**
 * Characters that end a phrase in the scripts the fallback serves. A CJK
 * message carries no inter-word spaces, so its whole sentence is a single
 * word and only a phrase boundary keeps the truncated fallback readable.
 */
const PHRASE_BOUNDARY = /[，。；：、！？,.;:!?]/u

/**
 * Truncate at the last phrase boundary that fits, falling back to the hard
 * byte cut when no boundary survives half the budget. Half the budget is the
 * floor that keeps the boundary rule from turning a capped title into a stub.
 * @param input - normalized single-line text.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns the longest phrase-aligned prefix within the budget.
 */
function truncateAtPhraseBoundary(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  const hard = truncateTitleUtf8(input, maxBytes)
  const minimumBytes = Math.ceil(maxBytes / 2)
  let prefix = ''
  let used = 0
  let boundary = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    used += bytes
    prefix += character
    if (PHRASE_BOUNDARY.test(character)) boundary = prefix
  }
  return Buffer.byteLength(boundary, 'utf8') >= minimumBytes ? boundary.trimEnd() : hard
}

/**
 * Derive the deterministic first-prompt fallback.
 * @param input - text from the first eligible human message.
 * @param maxWords - positive whitespace-delimited word cap.
 * @param maxBytes - positive UTF-8 byte cap.
 * @returns the normalized leading words within both limits.
 */
export function fallbackSessionTitle(input: string, maxWords: number, maxBytes: number): string {
  assertPositiveInteger('maxWords', maxWords)
  assertPositiveInteger('maxBytes', maxBytes)
  const words = cleanTitleText(input).split(' ').filter(Boolean).slice(0, maxWords)
  return truncateAtPhraseBoundary(words.join(' '), maxBytes).trimEnd()
}

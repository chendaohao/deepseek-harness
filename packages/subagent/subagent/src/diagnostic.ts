/**
 * The one byte limit every {@link SubagentResult.diagnostic} passes through.
 *
 * Two producers fill that field — an out-of-process backend's own failure text
 * and a local child's last `turn/end` failure — and a parent's settlement
 * notice renders whichever arrives. Keeping the cap in one place is what makes
 * "at most 4096 UTF-8 bytes" a property of the field rather than of one
 * backend that remembered.
 *
 * @module @deepseek-ai/dsh-subagent/diagnostic
 */

/** Maximum UTF-8 size of {@link SubagentResult.diagnostic}. */
export const MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096

const DIAGNOSTIC_TRUNCATION_SUFFIX = '\n[diagnostic truncated]'
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * Limit failure detail without splitting a UTF-8 sequence.
 * @param diagnostic - safe diagnostic text produced by a backend.
 * @returns the original text, or a visibly truncated value within the limit.
 */
export function limitSubagentDiagnostic(diagnostic: string): string {
  const bytes = utf8Encoder.encode(diagnostic)
  if (bytes.byteLength <= MAX_SUBAGENT_DIAGNOSTIC_BYTES) return diagnostic

  const suffixBytes = utf8Encoder.encode(DIAGNOSTIC_TRUNCATION_SUFFIX).byteLength
  let prefixBytes = MAX_SUBAGENT_DIAGNOSTIC_BYTES - suffixBytes
  while (((bytes[prefixBytes] as number) & 0b1100_0000) === 0b1000_0000) {
    prefixBytes -= 1
  }
  return utf8Decoder.decode(bytes.subarray(0, prefixBytes))
    + DIAGNOSTIC_TRUNCATION_SUFFIX
}

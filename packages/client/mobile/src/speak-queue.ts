/**
 * SpeakQueue: turns streamed assistant text into sequential TTS utterances.
 * A sentence completes as soon as its terminal punctuation arrives, so speech
 * starts while the turn still streams; turn end flushes the remainder.
 * Fenced code blocks are tracked incrementally and never spoken; markdown
 * structure never reaches the speaker. Barge-in clears the queue and stops
 * the active utterance.
 * @module @deepseek-ai/dsh-client-mobile
 */

/** Speak sink the app injects (expo-speech). */
export interface SpeakPort {
  speak(text: string, onDone: () => void, onError: (message: string) => void): void
  stop(): void
}

/** Queue options. */
export interface SpeakQueueOptions {
  /** Whether feeding produces speech at all (voice mode off = silent queue). */
  autoSpeak: boolean
  /** The injected speak sink. */
  port: SpeakPort
  /** Speaking-state listener for the snapshot. */
  onSpeakingChange?(speaking: boolean): void
  /** Soft maximum utterance length in characters. */
  maxChunkLength?: number
}

const DEFAULT_MAX_CHUNK_LENGTH = 200

/** The three-backtick code fence, written as an escape so the source needs no literal backticks. */
const FENCE = '\x60\x60\x60'

/** Delimiters that end a speakable sentence (kept with the sentence). */
const SENTENCE_ENDERS = /[。！？!?…]|\.(?:\s|$)|\.$/g

/**
 * Strip markdown down to speakable plain text: fenced code blocks vanish,
 * links keep their label, formatting markers drop, and whitespace collapses.
 * @param markdown - assistant markdown text.
 * @returns plain speakable text.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_~|]/g, ' ')
    .replace(/\x60/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Split plain text into bounded utterances, breaking at sentence-ending
 * punctuation and only then at whitespace when a sentence exceeds the cap.
 * @param text - plain text.
 * @param maxLength - soft per-utterance cap.
 * @returns ordered utterance fragments.
 */
export function splitSentences(text: string, maxLength: number = DEFAULT_MAX_CHUNK_LENGTH): string[] {
  const sentences: string[] = []
  let start = 0
  SENTENCE_ENDERS.lastIndex = 0
  for (let match = SENTENCE_ENDERS.exec(text); match !== null; match = SENTENCE_ENDERS.exec(text)) {
    const end = match.index + match[0].length
    sentences.push(text.slice(start, end).trim())
    start = end
  }
  const tail = text.slice(start).trim()
  if (tail !== '') sentences.push(tail)
  // Sentences stay separate so streaming can speak each completed one; only
  // an over-long sentence is further split to respect the utterance cap.
  return sentences.filter(part => part !== '').flatMap(sentence =>
    sentence.length <= maxLength ? [sentence] : hardSplit(sentence, maxLength))
}

/** Split one over-long fragment at whitespace boundaries, hard-cutting when none exists. */
function hardSplit(text: string, maxLength: number): string[] {
  const pieces: string[] = []
  let rest = text
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf(' ', maxLength)
    if (cut <= 0) cut = maxLength
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  /* v8 ignore next -- splitSentences trims every fragment, so a hard-split remainder is never whitespace-only */
  if (rest !== '') pieces.push(rest)
  return pieces
}

/**
 * Sequential speech queue over one assistant turn.
 * @param options - autoSpeak flag, port, and callbacks.
 */
export class SpeakQueue {
  private readonly options: SpeakQueueOptions
  private readonly maxChunkLength: number
  private buffer = ''
  private inFence = false
  private queue: string[] = []
  private active = false

  constructor(options: SpeakQueueOptions) {
    this.options = options
    this.maxChunkLength = options.maxChunkLength ?? DEFAULT_MAX_CHUNK_LENGTH
  }

  /** Whether an utterance is currently being spoken. */
  get speaking(): boolean {
    return this.active
  }

  /**
   * Feed a live text delta; completed sentences are spoken immediately.
   * Text inside a not-yet-closed code fence is dropped instead of spoken.
   * @param delta - one text-delta chunk.
   */
  feed(delta: string): void {
    if (!this.options.autoSpeak || delta === '') return
    this.buffer += delta
    this.drainFences()
    const sentences = splitSentences(this.buffer, this.maxChunkLength)
    const complete = sentences.slice(0, -1)
    this.buffer = sentences[sentences.length - 1] ?? ''
    for (const sentence of complete) this.enqueue(speakableText(sentence))
  }

  /**
   * Flush the turn remainder: speak the buffered tail (an unclosed fence is
   * dropped). Completed sentences already left the queue while streaming, so
   * nothing is spoken twice.
   */
  flushRemainder(): void {
    if (!this.options.autoSpeak) return
    if (this.inFence) {
      this.buffer = ''
      this.inFence = false
      return
    }
    const rest = speakableText(this.buffer)
    this.buffer = ''
    this.enqueue(rest)
  }

  /** Barge-in: drop queued and buffered text and stop the active utterance. */
  clear(): void {
    this.buffer = ''
    this.inFence = false
    this.queue = []
    if (this.active) {
      this.active = false
      this.options.port.stop()
      this.options.onSpeakingChange?.(false)
    }
  }

  /** Walk the buffer, speaking prose and dropping complete fence bodies. */
  private drainFences(): void {
    for (;;) {
      if (this.inFence) {
        const close = this.buffer.indexOf(FENCE)
        if (close === -1) return
        this.buffer = this.buffer.slice(close + FENCE.length)
        this.inFence = false
        continue
      }
      const open = this.buffer.indexOf(FENCE)
      if (open === -1) return
      // The prose before a fence opener may be a sentence fragment; speaking
      // it now beats interleaving code into the utterance. The opener itself
      // leaves the buffer, so the next close search finds the real closer.
      this.enqueue(speakableText(this.buffer.slice(0, open)))
      this.buffer = this.buffer.slice(open + FENCE.length)
      this.inFence = true
    }
  }

  private enqueue(text: string): void {
    if (text === '') return
    this.queue.push(text)
    this.drain()
  }

  private drain(): void {
    if (this.active) return
    const next = this.queue.shift()
    if (next === undefined) return
    this.active = true
    this.options.onSpeakingChange?.(true)
    this.options.port.speak(next, () => {
      this.active = false
      this.options.onSpeakingChange?.(false)
      this.drain()
    }, () => {
      // One bad utterance (e.g. a missing device voice) must not strand the
      // rest of the turn: drop it and keep going.
      this.active = false
      this.options.onSpeakingChange?.(false)
      this.drain()
    })
  }
}

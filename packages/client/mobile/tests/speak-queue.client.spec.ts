import { describe, expect, it } from 'vitest'
import { SpeakQueue, speakableText, splitSentences, type SpeakPort } from '../src/speak-queue.ts'

interface RecordingPort {
  port: SpeakPort
  spoken: string[]
  doneHandlers: (() => void)[]
  errorHandlers: ((message: string) => void)[]
  stopCount(): number
}

function recordingPort(): RecordingPort {
  const spoken: string[] = []
  const doneHandlers: (() => void)[] = []
  const errorHandlers: ((message: string) => void)[] = []
  let stopCalls = 0
  return {
    port: {
      speak: (text, onDone, onError) => {
        spoken.push(text)
        doneHandlers.push(onDone)
        errorHandlers.push(onError)
      },
      stop: () => { stopCalls += 1 },
    },
    spoken, doneHandlers, errorHandlers,
    stopCount: () => stopCalls,
  }
}

describe('speakableText', () => {
  it('drops fenced code blocks, formatting, links, and inline code', () => {
    expect(speakableText('你好。\x60\x60\x60ts\nconst x = 1\n\x60\x60\x60\n这是 **重点** 和 [链接](https://x)。\x60code\x60'))
      .toBe('你好。 这是 重点 和 链接。 code')
  })

  it('keeps link labels and image alt text', () => {
    expect(speakableText('见 [文档](url) 与 ![图](img)')).toBe('见 文档 与 图')
  })

  it('strips HTML tags and collapses whitespace', () => {
    expect(speakableText('  a<br/>\n\n   b ')).toBe('a b')
  })

  it('returns empty for empty input', () => {
    expect(speakableText('')).toBe('')
    expect(speakableText('\x60\x60\x60\n\x60\x60\x60')).toBe('')
  })
})

describe('splitSentences', () => {
  it('splits on Chinese and ASCII sentence enders, keeping the punctuation', () => {
    expect(splitSentences('第一句。第二句！第三句？英文. 结尾')).toEqual(['第一句。', '第二句！', '第三句？', '英文.', '结尾'])
  })

  it('keeps short sentences as separate utterances', () => {
    expect(splitSentences('嗯。好。')).toEqual(['嗯。', '好。'])
  })

  it('hard-splits an over-long sentence at whitespace', () => {
    const pieces = splitSentences('word '.repeat(60), 30)
    expect(pieces.every(piece => piece.length <= 30)).toBe(true)
    expect(pieces.join(' ')).toBe('word '.repeat(60).trim())
  })

  it('hard-cuts when no whitespace exists', () => {
    const pieces = splitSentences('x'.repeat(70), 30)
    expect(pieces).toHaveLength(3)
    expect(pieces.join('')).toBe('x'.repeat(70))
  })

  it('returns nothing for empty or blank input', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('   ')).toEqual([])
  })

  it('drops an all-whitespace hard-split remainder', () => {
    expect(splitSentences('y'.repeat(30) + '    ', 30)).toEqual(['y'.repeat(30)])
  })
})

describe('SpeakQueue', () => {
  it('speaks completed sentences as they stream and flushes only the remainder', () => {
    const { port, spoken, doneHandlers } = recordingPort()
    const speaking: boolean[] = []
    const queue = new SpeakQueue({ autoSpeak: true, port, onSpeakingChange: value => speaking.push(value) })
    queue.feed('第一句。第二')
    expect(spoken).toEqual(['第一句。'])
    expect(speaking).toEqual([true])
    doneHandlers[0]!()
    queue.feed('句')
    queue.flushRemainder()
    expect(spoken).toEqual(['第一句。', '第二句'])
    expect(speaking).toEqual([true, false, true])
  })

  it('is silent when autoSpeak is off', () => {
    const { port, spoken } = recordingPort()
    const queue = new SpeakQueue({ autoSpeak: false, port })
    queue.feed('你好。')
    queue.flushRemainder()
    expect(spoken).toEqual([])
  })

  it('drops code fence bodies during streaming and the open fence at flush', () => {
    const { port, spoken, doneHandlers } = recordingPort()
    const queue = new SpeakQueue({ autoSpeak: true, port })
    queue.feed('前面。\x60\x60\x60ts\ncode\n')
    expect(spoken).toEqual(['前面。'])
    queue.feed('more code\n\x60\x60\x60后面')
    queue.flushRemainder()
    doneHandlers[0]!()
    expect(spoken).toEqual(['前面。', '后面'])
  })

  it('never speaks an open fence body even when it carries sentence-ending punctuation', () => {
    const { port, spoken, doneHandlers } = recordingPort()
    const queue = new SpeakQueue({ autoSpeak: true, port })
    queue.feed('说完了。下面看代码：\x60\x60\x60python\nprint("你好。世界")\n')
    expect(spoken).toEqual(['说完了。下面看代码：'])
    queue.feed('x = 1\n\x60\x60\x60代码结束。')
    queue.flushRemainder()
    doneHandlers[0]!()
    expect(spoken).toEqual(['说完了。下面看代码：', '代码结束。'])
  })

  it('speaks the prose before a fence opener even mid-sentence', () => {
    const { port, spoken, doneHandlers } = recordingPort()
    const queue = new SpeakQueue({ autoSpeak: true, port })
    queue.feed('开头\x60\x60\x60js\nconst a=1\n\x60\x60\x60结尾')
    queue.flushRemainder()
    doneHandlers[0]!()
    expect(spoken).toEqual(['开头', '结尾'])
  })

  it('clears buffered, queued, and active speech on barge-in', () => {
    const recording = recordingPort()
    const { port, spoken, doneHandlers } = recording
    const stopCount = () => recording.stopCount()
    const speaking: boolean[] = []
    const queue = new SpeakQueue({ autoSpeak: true, port, onSpeakingChange: value => speaking.push(value) })
    queue.feed('第一句。第二句。第三句')
    expect(spoken).toEqual(['第一句。'])
    expect(queue.speaking).toBe(true)
    queue.clear()
    expect(stopCount()).toBe(1)
    expect(queue.speaking).toBe(false)
    expect(speaking.at(-1)).toBe(false)
    doneHandlers[0]!()
    expect(spoken).toHaveLength(1)
    queue.flushRemainder()
    expect(spoken).toHaveLength(1)
  })

  it('continues the queue after an utterance error', () => {
    const { port, spoken, errorHandlers } = recordingPort()
    const queue = new SpeakQueue({ autoSpeak: true, port })
    queue.feed('第一句。第二句。')
    expect(spoken).toEqual(['第一句。'])
    errorHandlers[0]!('no voice')
    expect(queue.speaking).toBe(false)
    queue.flushRemainder()
    expect(spoken).toEqual(['第一句。', '第二句。'])
  })

  it('ignores empty deltas and empty cleaned text', () => {
    const { port, spoken } = recordingPort()
    const queue = new SpeakQueue({ autoSpeak: true, port })
    queue.feed('')
    queue.feed(' \n ')
    queue.feed('\x60\x60\x60')
    queue.flushRemainder()
    expect(spoken).toEqual([])
  })

  it('cleans markdown from flushed remainder text', () => {
    const { port, spoken } = recordingPort()
    const queue = new SpeakQueue({ autoSpeak: true, port })
    queue.feed('看 [链接](https://x)')
    queue.flushRemainder()
    expect(spoken).toEqual(['看 链接'])
  })
})

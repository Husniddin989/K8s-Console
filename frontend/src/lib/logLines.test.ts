import { describe, expect, it } from 'vitest'
import { appendLogChunk, emptyLogBuffer, lineTimestamp, markLogReconnect } from './logLines'

const line = (seconds: number, text: string, fraction = '') => '2026-01-01T00:00:' + String(seconds).padStart(2, '0') + fraction + 'Z ' + text

describe('lineTimestamp', () => {
  it('normalizes trimmed RFC3339Nano fractions so they sort as strings', () => {
    expect(lineTimestamp(line(1, 'a', '.5'))).toBe('2026-01-01T00:00:01.500000000Z')
    expect(lineTimestamp(line(1, 'a'))).toBe('2026-01-01T00:00:01.000000000Z')
    expect(lineTimestamp(line(1, 'a', '.5'))! > lineTimestamp(line(1, 'a', '.123456789'))!).toBe(true)
    expect(lineTimestamp('no timestamp here')).toBeNull()
  })
})

describe('appendLogChunk', () => {
  it('keeps a line split across chunks together (regression)', () => {
    let buffer = appendLogChunk(emptyLogBuffer, line(1, 'hello wo'))
    expect(buffer.lines).toEqual([])
    buffer = appendLogChunk(buffer, 'rld\n' + line(2, 'next') + '\n')
    expect(buffer.lines).toEqual([line(1, 'hello world'), line(2, 'next')])
    expect(buffer.partial).toBe('')
  })

  it('drops blank lines and caps the buffer', () => {
    const chunk = Array.from({ length: 8 }, (_value, index) => line(index, 'n' + index)).join('\n\n') + '\n'
    const buffer = appendLogChunk(emptyLogBuffer, chunk, 5)
    expect(buffer.lines).toHaveLength(5)
    expect(buffer.lines[4]).toBe(line(7, 'n7'))
  })
})

describe('markLogReconnect', () => {
  it('does not repeat the tail the API replays after a reconnect (regression)', () => {
    let buffer = appendLogChunk(emptyLogBuffer, [line(1, 'a'), line(2, 'b'), line(3, 'c')].join('\n') + '\n')
    buffer = markLogReconnect(buffer)
    buffer = appendLogChunk(buffer, [line(1, 'a'), line(2, 'b'), line(3, 'c'), line(4, 'd')].join('\n') + '\n')
    expect(buffer.lines).toEqual([line(1, 'a'), line(2, 'b'), line(3, 'c'), line(4, 'd')])
    // Once new output arrives, later lines are accepted normally.
    buffer = appendLogChunk(buffer, 'untimestamped\n')
    expect(buffer.lines.at(-1)).toBe('untimestamped')
  })

  it('flushes a pending partial line when the stream drops', () => {
    const buffer = markLogReconnect(appendLogChunk(emptyLogBuffer, line(5, 'cut off')))
    expect(buffer.lines).toEqual([line(5, 'cut off')])
    expect(buffer.partial).toBe('')
    expect(buffer.resumeAfter).toBe('2026-01-01T00:00:05.000000000Z')
  })

  it('accepts everything after a reconnect when nothing was shown before', () => {
    const buffer = appendLogChunk(markLogReconnect(emptyLogBuffer), line(1, 'a') + '\n')
    expect(buffer.lines).toEqual([line(1, 'a')])
  })
})

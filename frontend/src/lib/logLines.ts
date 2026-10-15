export interface LogBuffer {
  lines: string[]
  /** Text after the last newline; Kubernetes chunks can end mid-line. */
  partial: string
  lastTimestamp: string | null
  /** After a reconnect the API replays its tail; lines at or before this timestamp were already shown. */
  resumeAfter: string | null
}

export const emptyLogBuffer: LogBuffer = { lines: [], partial: '', lastTimestamp: null, resumeAfter: null }

const timestampPattern = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z\s/

/** Returns a fixed-width UTC timestamp so plain string comparison orders lines correctly. */
export function lineTimestamp(line: string): string | null {
  const match = timestampPattern.exec(line)
  if (!match) return null
  return match[1] + '.' + (match[2] || '').padEnd(9, '0') + 'Z'
}

function pushLines(buffer: LogBuffer, incoming: string[], maxLines: number): LogBuffer {
  let { lastTimestamp, resumeAfter } = buffer
  const accepted: string[] = []
  for (const line of incoming) {
    if (!line) continue
    const timestamp = lineTimestamp(line)
    if (resumeAfter) {
      if (timestamp && timestamp <= resumeAfter) continue
      resumeAfter = null
    }
    if (timestamp) lastTimestamp = timestamp
    accepted.push(line)
  }
  const lines = accepted.length ? buffer.lines.concat(accepted).slice(-maxLines) : buffer.lines
  return { lines, partial: buffer.partial, lastTimestamp, resumeAfter }
}

export function appendLogChunk(buffer: LogBuffer, chunk: string, maxLines = 500): LogBuffer {
  const parts = (buffer.partial + chunk).split('\n')
  const partial = parts.pop() ?? ''
  return { ...pushLines({ ...buffer, partial }, parts, maxLines), partial }
}

/** Flushes any partial line and remembers where to resume, so the replayed tail is not shown twice. */
export function markLogReconnect(buffer: LogBuffer, maxLines = 500): LogBuffer {
  const flushed = buffer.partial ? pushLines({ ...buffer, partial: '' }, [buffer.partial], maxLines) : buffer
  return { ...flushed, partial: '', resumeAfter: flushed.lastTimestamp }
}

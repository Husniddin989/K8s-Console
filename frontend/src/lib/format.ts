export function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

export type StatusTone = 'good' | 'pending' | 'neutral' | 'bad'

const good = ['running', 'ready', 'normal', 'active', 'bound']
const pending = ['pending', 'containercreating', 'podinitializing', 'unknown', 'progressing', 'terminating', 'notready,schedulingdisabled']
const neutral = ['succeeded', 'completed']

export function statusTone(status: string): StatusTone {
  const normalized = status.toLowerCase()
  if (good.includes(normalized) || normalized === 'ready,schedulingdisabled') return 'good'
  if (neutral.includes(normalized)) return 'neutral'
  if (/error|backoff|failed|oomkilled|invalid|evicted|exitcode|signal/.test(normalized)) return 'bad'
  if (pending.includes(normalized) || normalized.startsWith('init:')) return 'pending'
  return 'bad'
}

/** "12" when unfiltered, "3 of 12" when a search narrows the list. */
export function countLabel(shown: number, total: number): string {
  return shown === total ? String(total) : shown + ' of ' + total
}

/** kubectl's AGE formatting (k8s.io/apimachinery duration.HumanDuration): 45s, 7m32s, 88m, 5h12m, 3d4h, 120d. */
export function humanDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < -1) return '<invalid>'
  if (seconds < 0) return '0s'
  if (seconds < 60 * 2) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 10) return seconds % 60 === 0 ? minutes + 'm' : minutes + 'm' + (seconds % 60) + 's'
  if (minutes < 60 * 3) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 8) return minutes % 60 === 0 ? hours + 'h' : hours + 'h' + (minutes % 60) + 'm'
  if (hours < 48) return hours + 'h'
  if (hours < 24 * 8) return hours % 24 === 0 ? Math.floor(hours / 24) + 'd' : Math.floor(hours / 24) + 'd' + (hours % 24) + 'h'
  if (hours < 24 * 365 * 2) return Math.floor(hours / 24) + 'd'
  const years = Math.floor(hours / 24 / 365)
  const days = Math.floor(hours / 24) % 365
  if (hours < 24 * 365 * 8) return days === 0 ? years + 'y' : years + 'y' + days + 'd'
  return years + 'y'
}

export function age(timestamp: string | null, now = Date.now()): string {
  if (!timestamp) return '<unknown>'
  const time = Date.parse(timestamp)
  return Number.isNaN(time) ? '<unknown>' : humanDuration(now - time)
}

/** Milliseconds since the timestamp, for sorting by age (missing values sort last). */
export function ageMs(timestamp: string | null, now = Date.now()): number {
  const time = timestamp ? Date.parse(timestamp) : Number.NaN
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : now - time
}

/** kubectl's RESTARTS column: `3` or `1 (71m ago)`. */
export function restartsText(restarts: number, lastRestartAt: string | null, now = Date.now()): string {
  return lastRestartAt && restarts > 0 ? restarts + ' (' + age(lastRestartAt, now) + ' ago)' : String(restarts)
}

/** A pod needs attention when kubectl would not show it as plainly healthy. */
export function needsAttention(pod: { status: string; ready: number; containers: number; restarts: number }): boolean {
  if (pod.status === 'Completed' || pod.status === 'Succeeded') return false
  return pod.status !== 'Running' || pod.ready < pod.containers || pod.restarts > 0
}

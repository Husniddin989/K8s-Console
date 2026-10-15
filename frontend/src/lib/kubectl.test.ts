import { describe, expect, it } from 'vitest'
import { age, ageMs, humanDuration, needsAttention, restartsText } from './kubectl'

const second = 1000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour

describe('humanDuration (kubectl AGE)', () => {
  it.each([
    [45 * second, '45s'],
    [119 * second, '119s'],
    [7 * minute + 32 * second, '7m32s'],
    [9 * minute, '9m'],
    [88 * minute, '88m'],
    [5 * hour + 12 * minute, '5h12m'],
    [30 * hour, '30h'],
    [3 * day + 4 * hour, '3d4h'],
    [120 * day, '120d'],
    [3 * 365 * day + 10 * day, '3y10d'],
    [-500, '0s'],
  ])('%d ms → %s', (input, expected) => {
    expect(humanDuration(input)).toBe(expected)
  })
})

describe('age helpers', () => {
  const now = Date.parse('2026-10-15T12:00:00Z')
  it('formats ages and restart counts like kubectl', () => {
    expect(age('2026-10-15T10:32:00Z', now)).toBe('88m')
    expect(age(null, now)).toBe('<unknown>')
    expect(restartsText(1, '2026-10-15T10:49:00Z', now)).toBe('1 (71m ago)')
    expect(restartsText(0, null, now)).toBe('0')
    expect(restartsText(2, null, now)).toBe('2')
  })

  it('sorts missing timestamps last', () => {
    expect(ageMs(null, now)).toBeGreaterThan(ageMs('2000-01-01T00:00:00Z', now))
  })
})

describe('needsAttention', () => {
  it('flags failing, unready and restarted pods but not completed jobs', () => {
    expect(needsAttention({ status: 'Running', ready: 1, containers: 1, restarts: 0 })).toBe(false)
    expect(needsAttention({ status: 'Completed', ready: 0, containers: 1, restarts: 0 })).toBe(false)
    expect(needsAttention({ status: 'Running', ready: 0, containers: 1, restarts: 0 })).toBe(true)
    expect(needsAttention({ status: 'Running', ready: 1, containers: 1, restarts: 1 })).toBe(true)
    expect(needsAttention({ status: 'CrashLoopBackOff', ready: 0, containers: 1, restarts: 5 })).toBe(true)
  })
})

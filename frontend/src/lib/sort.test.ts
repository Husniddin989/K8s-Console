import { describe, expect, it } from 'vitest'
import { sortRows } from './sort'

describe('sortRows', () => {
  const rows = [{ name: 'pod-10', n: 3 }, { name: 'pod-2', n: 1 }, { name: 'Pod-1', n: 3 }]

  it('sorts names naturally and case-insensitively', () => {
    expect(sortRows(rows, (row) => row.name, 'asc').map((row) => row.name)).toEqual(['Pod-1', 'pod-2', 'pod-10'])
    expect(sortRows(rows, (row) => row.name, 'desc').map((row) => row.name)).toEqual(['pod-10', 'pod-2', 'Pod-1'])
  })

  it('sorts numbers numerically and keeps ties in their original order', () => {
    expect(sortRows(rows, (row) => row.n, 'asc').map((row) => row.name)).toEqual(['pod-2', 'pod-10', 'Pod-1'])
    expect(sortRows(rows, (row) => row.n, 'desc').map((row) => row.name)).toEqual(['pod-10', 'Pod-1', 'pod-2'])
  })

  it('does not mutate the input', () => {
    const copy = rows.slice()
    sortRows(rows, (row) => row.name, 'asc')
    expect(rows).toEqual(copy)
  })
})

export type SortDirection = 'asc' | 'desc'
export type SortValue = string | number

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Stable sort by one column; strings compare naturally so `pod-2` comes before `pod-10`. */
export function sortRows<T>(rows: T[], value: (row: T) => SortValue, direction: SortDirection): T[] {
  const factor = direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index, key: value(row) }))
    .sort((a, b) => {
      const order = typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : collator.compare(String(a.key), String(b.key))
      return order * factor || a.index - b.index
    })
    .map((entry) => entry.row)
}

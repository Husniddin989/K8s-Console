import { describe, expect, it } from 'vitest'
import { actionLabel } from './auditLabels'

describe('actionLabel', () => {
  it('names known actions and falls back to the raw id', () => {
    expect(actionLabel('deployment.scale')).toBe('Scale deployment')
    expect(actionLabel('pod.shell')).toBe('Open shell')
    expect(actionLabel('custom.thing')).toBe('custom.thing')
  })
})

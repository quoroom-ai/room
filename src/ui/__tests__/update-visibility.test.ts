import { describe, expect, it } from 'vitest'
import { shouldShowManualUpdateControls, shouldShowUpdateModal } from '../lib/update-visibility'

describe('update visibility', () => {
  it('hides manual update controls in cloud mode', () => {
    expect(shouldShowManualUpdateControls('cloud')).toBe(false)
    expect(shouldShowManualUpdateControls('local')).toBe(true)
  })

  it('never shows update modal in cloud mode', () => {
    expect(shouldShowUpdateModal('cloud', true, false)).toBe(false)
    expect(shouldShowUpdateModal('local', true, false)).toBe(true)
    expect(shouldShowUpdateModal('local', true, true)).toBe(false)
    expect(shouldShowUpdateModal('local', false, false)).toBe(false)
  })
})

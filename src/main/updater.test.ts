import { describe, expect, it } from 'vitest'
import { compareVersions } from './updater'

describe('compareVersions', () => {
  it('сравнивает числами, а не строками', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v0.2.0', '0.1.0')).toBe(1)
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
  })
  it('предрелиз младше релиза', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
  })
})

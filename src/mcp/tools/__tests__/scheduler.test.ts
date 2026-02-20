import { describe, it, expect } from 'vitest'
import { generateTaskName } from '../scheduler'

describe('generateTaskName', () => {
  it('returns short prompts as-is', () => {
    expect(generateTaskName('Check HN top stories')).toBe('Check HN top stories')
  })

  it('strips "please " prefix', () => {
    expect(generateTaskName('please check my email')).toBe('check my email')
  })

  it('strips "can you " prefix', () => {
    expect(generateTaskName('can you summarize the report')).toBe('summarize the report')
  })

  it('strips "i want you to " prefix', () => {
    expect(generateTaskName('i want you to organize my downloads')).toBe('organize my downloads')
  })

  it('strips "i need you to " prefix', () => {
    expect(generateTaskName('i need you to clean up temp files')).toBe('clean up temp files')
  })

  it('takes only the first sentence', () => {
    expect(generateTaskName('Check emails. Then organize them.')).toBe('Check emails')
  })

  it('takes only the first line', () => {
    expect(generateTaskName('Check emails\nThen organize')).toBe('Check emails')
  })

  it('truncates names longer than 40 characters', () => {
    const longPrompt = 'This is a very long task name that goes well beyond the forty character limit we impose'
    const result = generateTaskName(longPrompt)
    expect(result.length).toBeLessThanOrEqual(40)
    expect(result).toMatch(/\.\.\.$/)
  })

  it('returns exactly 40 chars for a 40-char first sentence', () => {
    const exact40 = 'A'.repeat(40)
    expect(generateTaskName(exact40)).toBe(exact40)
  })

  it('handles case-insensitive prefix stripping', () => {
    expect(generateTaskName('Please update the dashboard')).toBe('update the dashboard')
    expect(generateTaskName('PLEASE update the dashboard')).toBe('update the dashboard')
  })

  it('handles empty prompt', () => {
    expect(generateTaskName('')).toBe('')
  })

  it('handles prompt with only prefix', () => {
    expect(generateTaskName('please ')).toBe('')
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import {
  getOpenRouterStreamMode,
  resolveModelFallbackChain,
  resolveOpenRouterApiKey,
  resolveOpenRouterBaseUrl,
  resolveOpenRouterModel,
} from '../src/services/api/openrouterConfig.js'
import { resolveStreamEnabled, shouldRetryWithFallback } from '../src/services/api/openaiShim.js'

const KEYS = ['OPENROUTER_STREAM','OPENROUTER_BASE_URL','OPENAI_BASE_URL','OPENROUTER_MODEL','OPENAI_MODEL','OPENROUTER_API_KEY','OPENAI_API_KEY','OPENROUTER_MODELS','OPENROUTER_PROFILE']
afterEach(() => { for (const k of KEYS) delete process.env[k] })

describe('openrouter aliases', () => {
  test('prefers OPENROUTER over OPENAI aliases', () => {
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini'
    process.env.OPENAI_MODEL = 'gpt-4o'
    process.env.OPENROUTER_API_KEY = 'or-key'
    process.env.OPENAI_API_KEY = 'oa-key'

    expect(resolveOpenRouterBaseUrl()).toBe('https://openrouter.ai/api/v1')
    expect(resolveOpenRouterModel()).toBe('openai/gpt-4o-mini')
    expect(resolveOpenRouterApiKey()).toBe('or-key')
  })

  test('stream modes', () => {
    process.env.OPENROUTER_STREAM = 'on'
    expect(getOpenRouterStreamMode()).toBe('on')
    expect(resolveStreamEnabled(false)).toBe(true)
    process.env.OPENROUTER_STREAM = 'off'
    expect(resolveStreamEnabled(true)).toBe(false)
    process.env.OPENROUTER_STREAM = 'auto'
    expect(resolveStreamEnabled(true)).toBe(true)
  })



  test('fallback retry policy only retries retryable statuses', () => {
    expect(shouldRetryWithFallback(429)).toBe(true)
    expect(shouldRetryWithFallback(503)).toBe(true)
    expect(shouldRetryWithFallback(400)).toBe(false)
    expect(shouldRetryWithFallback(401)).toBe(false)
  })
  test('fallback chain includes env and profile defaults', () => {
    process.env.OPENROUTER_MODELS = 'a,b'
    process.env.OPENROUTER_PROFILE = 'cheap'
    const chain = resolveModelFallbackChain('first')
    expect(chain[0]).toBe('first')
    expect(chain).toContain('a')
    expect(chain).toContain('b')
  })
})

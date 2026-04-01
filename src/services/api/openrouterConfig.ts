import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type OpenRouterProfile = 'free' | 'balanced' | 'reliable' | 'cheap'
export type OpenRouterStreamMode = 'auto' | 'on' | 'off'

const PROFILE_DEFAULTS: Record<OpenRouterProfile, string[]> = {
  free: ['openrouter/auto:free', 'meta-llama/llama-3.3-8b-instruct:free'],
  balanced: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash'],
  reliable: ['anthropic/claude-3.7-sonnet', 'openai/gpt-4.1'],
  cheap: ['openai/gpt-4o-mini', 'mistralai/mistral-small-3.1'],
}

export function resolveOpenRouterBaseUrl(): string {
  return (
    process.env.OPENROUTER_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    'https://openrouter.ai/api/v1'
  ).replace(/\/+$/, '')
}

export function resolveOpenRouterApiKey(): string {
  return process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? ''
}

export function resolveOpenRouterModel(): string {
  return process.env.OPENROUTER_MODEL ?? process.env.OPENAI_MODEL ?? 'openai/gpt-4o-mini'
}

export function getOpenRouterStreamMode(): OpenRouterStreamMode {
  const raw = (process.env.OPENROUTER_STREAM ?? 'auto').toLowerCase()
  if (raw === 'on' || raw === 'off' || raw === 'auto') return raw
  return 'auto'
}

export function resolveOpenRouterProfile(): OpenRouterProfile | null {
  const raw = process.env.OPENROUTER_PROFILE?.trim().toLowerCase()
  if (raw === 'free' || raw === 'balanced' || raw === 'reliable' || raw === 'cheap') return raw
  return null
}

export function resolveModelFallbackChain(primaryModel: string): string[] {
  const fromEnv = (process.env.OPENROUTER_MODELS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const profile = resolveOpenRouterProfile()
  const fromProfile = profile ? PROFILE_DEFAULTS[profile] : []

  return Array.from(new Set([primaryModel, ...fromEnv, ...fromProfile]))
}

function getCachePath(): string {
  return resolve(process.cwd(), '.openclaude', 'openrouter-models-cache.json')
}

export function readOpenRouterModelCache(): Record<string, unknown> | null {
  const path = getCachePath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function writeOpenRouterModelCache(payload: Record<string, unknown>): void {
  const path = getCachePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
}

export function modelLikelySupportsTools(metadata: unknown): boolean {
  const item = metadata as { supported_parameters?: string[]; architecture?: { input_modalities?: string[] } }
  const supported = item?.supported_parameters ?? []
  return supported.includes('tools') || supported.includes('tool_choice')
}

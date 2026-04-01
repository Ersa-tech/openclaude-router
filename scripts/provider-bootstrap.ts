// @ts-nocheck
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

type ProviderProfile = 'free' | 'balanced' | 'reliable' | 'cheap' | 'ollama'
const isProviderProfile = (v: string | null | undefined): v is ProviderProfile => ['free','balanced','reliable','cheap','ollama'].includes(v || '')

type ProfileFile = {
  profile: ProviderProfile
  env: {
    OPENROUTER_BASE_URL?: string
    OPENROUTER_MODEL?: string
    OPENROUTER_MODELS?: string
    OPENROUTER_API_KEY?: string
  }
  createdAt: string
}

const parseArg = (name: string) => { const args = process.argv.slice(2); const idx = args.indexOf(name); return idx === -1 ? null : (args[idx + 1] ?? null) }
const parseProviderArg = (): ProviderProfile | 'auto' => { const p = parseArg('--provider')?.toLowerCase(); return isProviderProfile(p) ? p : 'auto' }
const hasLocalOllama = async () => { try { return (await fetch('http://localhost:11434/api/tags')).ok } catch { return false } }
const sanitizeApiKey = (k: string | null) => (!k || k === 'SUA_CHAVE') ? undefined : k

async function main() {
  const provider = parseProviderArg()
  const argModel = parseArg('--model')
  const argBaseUrl = parseArg('--base-url')
  const argApiKey = parseArg('--api-key')
  const selected: ProviderProfile = provider === 'auto' ? ((await hasLocalOllama()) ? 'ollama' : 'balanced') : provider

  const env: ProfileFile['env'] = {}
  if (selected === 'ollama') {
    env.OPENROUTER_BASE_URL = argBaseUrl || 'http://localhost:11434/v1'
    env.OPENROUTER_MODEL = argModel || process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || 'llama3.1:8b'
  } else {
    env.OPENROUTER_BASE_URL = argBaseUrl || process.env.OPENROUTER_BASE_URL || process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1'
    env.OPENROUTER_MODEL = argModel || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini'
    const key = sanitizeApiKey(argApiKey || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || null)
    if (!key) { console.error('Hosted profiles require OPENROUTER_API_KEY (OPENAI_API_KEY alias also accepted).'); process.exit(1) }
    env.OPENROUTER_API_KEY = key
  }

  const profile: ProfileFile = { profile: selected, env, createdAt: new Date().toISOString() }
  const outputPath = resolve(process.cwd(), '.openclaude-profile.json')
  writeFileSync(outputPath, JSON.stringify(profile, null, 2), 'utf8')
  console.log(`Saved profile: ${selected}`)
  console.log(`Path: ${outputPath}`)
  console.log('Next: bun run dev:profile')
}

await main()

// @ts-nocheck
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type ProviderProfile = 'free' | 'balanced' | 'reliable' | 'cheap' | 'ollama'
type ProfileFile = { profile: ProviderProfile; env?: { OPENROUTER_BASE_URL?: string; OPENROUTER_MODEL?: string; OPENROUTER_MODELS?: string; OPENROUTER_API_KEY?: string } }


function isProviderProfile(value: unknown): value is ProviderProfile {
  return value === 'free' || value === 'balanced' || value === 'reliable' || value === 'cheap' || value === 'ollama'
}

function isDebugEnabled(): boolean {
  const v = process.env.OPENROUTER_DEBUG?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function debugLog(event: string, payload: Record<string, unknown>) {
  if (!isDebugEnabled()) return
  console.error(`[provider-launch] ${JSON.stringify({ event, ...payload })}`)
}

const PROFILE_MODELS: Record<Exclude<ProviderProfile, 'ollama'>, string> = {
  free: 'openrouter/auto:free',
  balanced: 'openai/gpt-4o-mini',
  reliable: 'anthropic/claude-3.7-sonnet',
  cheap: 'openai/gpt-4o-mini',
}

function parseLaunchOptions(argv: string[]) {
  let requested: ProviderProfile | 'auto' = 'auto'
  const passthrough: string[] = []
  let fast = false
  for (const arg of argv) {
    const lower = arg.toLowerCase()
    if (lower === '--fast') { fast = true; continue }
    if (['auto','free','balanced','reliable','cheap','ollama'].includes(lower) && requested === 'auto') { requested = lower as any; continue }
    passthrough.push(arg)
  }
  return { requested, passthrough, fast }
}

function loadPersistedProfile(): ProfileFile | null {
  const path = resolve(process.cwd(), '.openclaude-profile.json')
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProfileFile
    if (!isProviderProfile(parsed?.profile)) return null
    return parsed
  } catch {
    return null
  }
}

async function hasLocalOllama() { try { return (await fetch('http://localhost:11434/api/tags')).ok } catch { return false } }
const runCommand = (cmd: string, env: NodeJS.ProcessEnv) => new Promise<number>(resolve => { const c = spawn(cmd, { cwd: process.cwd(), env, stdio: 'inherit', shell: true }); c.on('close', code => resolve(code ?? 1)); c.on('error', () => resolve(1)) })

function buildEnv(profile: ProviderProfile, persisted: ProfileFile | null): NodeJS.ProcessEnv {
  const pe = persisted?.env ?? {}
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_USE_OPENAI: '1' }
  if (profile === 'ollama') {
    env.OPENROUTER_BASE_URL = pe.OPENROUTER_BASE_URL || process.env.OPENROUTER_BASE_URL || process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1'
    env.OPENROUTER_MODEL = pe.OPENROUTER_MODEL || process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || 'llama3.1:8b'
    delete env.OPENROUTER_API_KEY
  } else {
    env.OPENROUTER_BASE_URL = pe.OPENROUTER_BASE_URL || process.env.OPENROUTER_BASE_URL || process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1'
    env.OPENROUTER_MODEL = pe.OPENROUTER_MODEL || process.env.OPENROUTER_MODEL || PROFILE_MODELS[profile]
    env.OPENROUTER_MODELS = pe.OPENROUTER_MODELS || process.env.OPENROUTER_MODELS
    env.OPENROUTER_PROFILE = profile
    env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || pe.OPENROUTER_API_KEY
    env.OPENROUTER_STREAM = process.env.OPENROUTER_STREAM || 'auto'
  }
  env.OPENAI_BASE_URL = env.OPENROUTER_BASE_URL
  env.OPENAI_MODEL = env.OPENROUTER_MODEL
  env.OPENAI_API_KEY = env.OPENROUTER_API_KEY
  return env
}

async function main() {
  const opts = parseLaunchOptions(process.argv.slice(2))
  const persisted = loadPersistedProfile()
  let profile: ProviderProfile = opts.requested === 'auto' ? (persisted?.profile ?? ((await hasLocalOllama()) ? 'ollama' : 'balanced')) : opts.requested
  const env = buildEnv(profile, persisted)
  debugLog('resolved_profile', { profile, persisted: Boolean(persisted) })
  if (profile !== 'ollama' && (!env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY === 'SUA_CHAVE')) { console.error('OPENROUTER_API_KEY is required for hosted profiles.'); process.exit(1) }
  console.log(`Launching profile: ${profile}`)
  console.log(`OPENROUTER_BASE_URL=${env.OPENROUTER_BASE_URL}`)
  console.log(`OPENROUTER_MODEL=${env.OPENROUTER_MODEL}`)
  console.log(`OPENROUTER_STREAM=${env.OPENROUTER_STREAM ?? 'auto'}`)
  const doctor = await runCommand('bun run scripts/system-check.ts', env); if (doctor !== 0) process.exit(doctor)
  const cliArgs = opts.passthrough.map(a => (a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
  process.exit(await runCommand(cliArgs ? `bun run dev -- ${cliArgs}` : 'bun run dev', env))
}

await main()

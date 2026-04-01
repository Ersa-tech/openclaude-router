// @ts-nocheck
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

type CheckResult = { ok: boolean; label: string; detail?: string }
type CliOptions = { json: boolean; outFile: string | null }

const pass = (label: string, detail?: string): CheckResult => ({ ok: true, label, detail })
const fail = (label: string, detail?: string): CheckResult => ({ ok: false, label, detail })
const isTruthy = (v?: string) => !!v && !['', '0', 'false', 'no'].includes(v.trim().toLowerCase())

function parseOptions(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, outFile: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') options.json = true
    if (argv[i] === '--out' && argv[i + 1] && !argv[i + 1].startsWith('--')) options.outFile = argv[++i]
  }
  return options
}

const isLocalBaseUrl = (baseUrl: string) => {
  try { const u = new URL(baseUrl); return ['localhost', '127.0.0.1', '::1'].includes(u.hostname) } catch { return false }
}

const currentBaseUrl = () => process.env.OPENROUTER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1'
const currentModel = () => process.env.OPENROUTER_MODEL ?? process.env.OPENAI_MODEL
const currentKey = () => process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY

function checkProviderEnv(): CheckResult[] {
  const results: CheckResult[] = []
  if (!isTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    results.push(pass('Provider mode', 'Provider shim disabled.'))
    return results
  }
  const baseUrl = currentBaseUrl()
  const model = currentModel()
  const key = currentKey()

  results.push(pass('Provider mode', 'OpenRouter-first OpenAI-compatible shim enabled.'))
  results.push(pass('OPENROUTER_BASE_URL', baseUrl))
  results.push(model ? pass('OPENROUTER_MODEL', model) : pass('OPENROUTER_MODEL', 'Not set. Runtime default will be used.'))
  results.push(pass('OPENROUTER_STREAM', process.env.OPENROUTER_STREAM ?? 'auto'))

  if (key === 'SUA_CHAVE') results.push(fail('OPENROUTER_API_KEY', 'Placeholder value SUA_CHAVE detected.'))
  else if (!key && !isLocalBaseUrl(baseUrl)) results.push(fail('OPENROUTER_API_KEY', 'Missing key for non-local provider URL.'))
  else results.push(pass('OPENROUTER_API_KEY', key ? 'Configured.' : 'Not set (allowed for local endpoints).'))

  return results
}

async function checkReachability(): Promise<CheckResult> {
  if (!isTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) return pass('Provider reachability', 'Skipped (provider shim disabled).')
  const endpoint = `${currentBaseUrl().replace(/\/$/, '')}/models`
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 4000)
  try {
    const headers: Record<string, string> = {}
    if (currentKey()) headers.Authorization = `Bearer ${currentKey()}`
    const response = await fetch(endpoint, { headers, signal: controller.signal })
    if ([200, 401, 403].includes(response.status)) return pass('Provider reachability', `Reached ${endpoint} (status ${response.status}).`)
    return fail('Provider reachability', `Unexpected status ${response.status} from ${endpoint}.`)
  } catch (e) {
    return fail('Provider reachability', `Failed to reach ${endpoint}: ${e instanceof Error ? e.message : String(e)}`)
  } finally { clearTimeout(timeout) }
}

function checkOllamaProcessorMode(): CheckResult {
  const baseUrl = currentBaseUrl()
  if (!isTruthy(process.env.CLAUDE_CODE_USE_OPENAI) || !isLocalBaseUrl(baseUrl)) return pass('Ollama processor mode', 'Skipped.')
  const result = spawnSync('ollama', ['ps'], { cwd: process.cwd(), encoding: 'utf8', shell: true })
  if (result.status !== 0) return fail('Ollama processor mode', (result.stderr || result.stdout || 'Unable to run ollama ps').trim())
  return pass('Ollama processor mode', 'Local provider detected.')
}

function printResults(results: CheckResult[]) { for (const r of results) console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.label}${r.detail ? ` - ${r.detail}` : ''}`) }

function writeJsonReport(options: CliOptions, results: CheckResult[]) {
  const payload = { timestamp: new Date().toISOString(), cwd: process.cwd(), summary: { total: results.length, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, env: { CLAUDE_CODE_USE_OPENAI: isTruthy(process.env.CLAUDE_CODE_USE_OPENAI), OPENROUTER_MODEL: currentModel() ?? '(unset)', OPENROUTER_BASE_URL: currentBaseUrl(), OPENROUTER_API_KEY_SET: Boolean(currentKey()) }, results }
  if (options.json) console.log(JSON.stringify(payload, null, 2))
  if (options.outFile) { const p = resolve(process.cwd(), options.outFile); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8'); if (!options.json) console.log(`Report written to ${p}`) }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const results: CheckResult[] = [pass('Node.js version', process.versions.node), pass('Bun runtime', (globalThis as any).Bun?.version ?? 'Not running inside Bun (acceptable).')]
  results.push(...checkProviderEnv())
  results.push(await checkReachability())
  results.push(checkOllamaProcessorMode())
  if (!options.json) printResults(results)
  writeJsonReport(options, results)
  if (results.some(r => !r.ok)) process.exitCode = 1
}

await main()

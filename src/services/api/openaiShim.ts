/**
 * OpenRouter-first OpenAI-compatible shim.
 * OPENAI_* env vars are temporary compatibility aliases.
 */

import {
  getOpenRouterStreamMode,
  modelLikelySupportsTools,
  readOpenRouterModelCache,
  resolveModelFallbackChain,
  resolveOpenRouterApiKey,
  resolveOpenRouterBaseUrl,
  resolveOpenRouterModel,
  writeOpenRouterModelCache,
} from './openrouterConfig.js'


function isOpenRouterDebugEnabled(): boolean {
  const value = process.env.OPENROUTER_DEBUG?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function debugLog(event: string, payload: Record<string, unknown>): void {
  if (!isOpenRouterDebugEnabled()) return
  const serialized = JSON.stringify({ event, ...payload })
  console.error(`[openrouter:debug] ${serialized}`)
}

export class OpenRouterShimError extends Error {
  code: string
  status?: number

  constructor(message: string, options: { code: string; status?: number }) {
    super(message)
    this.name = 'OpenRouterShimError'
    this.code = options.code
    this.status = options.status
  }
}

export function shouldRetryWithFallback(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}
interface AnthropicStreamEvent {
  type: string
  message?: Record<string, unknown>
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  usage?: Partial<AnthropicUsage>
}
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}
interface OpenAITool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean }
}
interface OpenAIStreamChunk {
  choices: Array<{ index: number; delta: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function convertSystemPrompt(system: unknown): string {
  let base = ''
  if (!system) base = ''
  else if (typeof system === 'string') base = system
  else if (Array.isArray(system)) base = system.map((b: { type?: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : '')).join('\n\n')
  else base = String(system)

  if (process.env.OPENROUTER_WEAK_MODEL_ASSIST === '1') {
    return `${base}\n\nWhen calling tools, strictly output valid JSON arguments and keep one tool call at a time.`.trim()
  }
  return base
}

function convertContentBlocks(content: unknown): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  for (const block of content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text ?? '' })
    else if (block.type === 'image' && block.source?.type === 'base64') parts.push({ type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } })
    else if (block.type === 'image' && block.source?.type === 'url') parts.push({ type: 'image_url', image_url: { url: block.source.url } })
    else if (block.type === 'thinking' && block.thinking) parts.push({ type: 'text', text: `<thinking>${block.thinking}</thinking>` })
    else if (block.text) parts.push({ type: 'text', text: block.text })
  }
  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text ?? ''
  return parts
}

function convertMessages(messages: Array<{ role: string; message?: { role?: string; content?: unknown }; content?: unknown }>, system: unknown): OpenAIMessage[] {
  const result: OpenAIMessage[] = []
  const sysText = convertSystemPrompt(system)
  if (sysText) result.push({ role: 'system', content: sysText })
  for (const msg of messages) {
    const inner = msg.message ?? msg
    const role = (inner as { role?: string }).role ?? msg.role
    const content = (inner as { content?: unknown }).content
    if (role === 'user' && Array.isArray(content)) {
      const toolResults = content.filter((b: { type?: string }) => b.type === 'tool_result')
      const other = content.filter((b: { type?: string }) => b.type !== 'tool_result')
      for (const tr of toolResults) {
        const trContent = Array.isArray(tr.content) ? tr.content.map((c: { text?: string }) => c.text ?? '').join('\n') : typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? '')
        result.push({ role: 'tool', tool_call_id: tr.tool_use_id ?? 'unknown', content: tr.is_error ? `Error: ${trContent}` : trContent })
      }
      if (other.length > 0) result.push({ role: 'user', content: convertContentBlocks(other) })
    } else if (role === 'assistant' && Array.isArray(content)) {
      const toolUses = content.filter((b: { type?: string }) => b.type === 'tool_use')
      const textContent = content.filter((b: { type?: string }) => b.type !== 'tool_use' && b.type !== 'thinking')
      const assistantMsg: OpenAIMessage = { role: 'assistant', content: convertContentBlocks(textContent) as string }
      if (toolUses.length > 0) {
        assistantMsg.tool_calls = toolUses.map((tu: { id?: string; name?: string; input?: unknown }) => ({ id: tu.id ?? `call_${Math.random().toString(36).slice(2)}`, type: 'function', function: { name: tu.name ?? 'unknown', arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input ?? {}) } }))
      }
      result.push(assistantMsg)
    } else {
      result.push({ role: role as OpenAIMessage['role'], content: convertContentBlocks(content) as string })
    }
  }
  return result
}

function convertTools(tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>): OpenAITool[] {
  return tools.filter(t => t.name !== 'ToolSearchTool').map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } } }))
}

function makeMessageId(): string {
  return `msg_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export function resolveStreamEnabled(requested: boolean | undefined): boolean {
  const mode = getOpenRouterStreamMode()
  if (mode === 'on') return true
  if (mode === 'off') return false
  return requested ?? false
}

async function* openaiStreamToAnthropic(response: Response, model: string, signal?: AbortSignal): AsyncGenerator<AnthropicStreamEvent> {
  const messageId = makeMessageId()
  let contentBlockIndex = 0
  const activeToolCalls = new Map<number, { index: number }>()
  let hasText = false

  yield { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }

  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  const onAbort = () => reader.cancel().catch(() => undefined)
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) continue
        let chunk: OpenAIStreamChunk
        try { chunk = JSON.parse(trimmed.slice(6)) } catch { continue }
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta
          if (delta.content) {
            if (!hasText) { yield { type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'text', text: '' } }; hasText = true }
            yield { type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'text_delta', text: delta.content } }
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.id && tc.function?.name) {
                if (hasText) { yield { type: 'content_block_stop', index: contentBlockIndex }; contentBlockIndex++; hasText = false }
                const toolIndex = contentBlockIndex
                activeToolCalls.set(tc.index, { index: toolIndex })
                yield { type: 'content_block_start', index: toolIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } }
                if (tc.function.arguments) yield { type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }
                contentBlockIndex++
              } else if (tc.function?.arguments) {
                const active = activeToolCalls.get(tc.index)
                if (active) yield { type: 'content_block_delta', index: active.index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } }
              }
            }
          }
          if (choice.finish_reason) {
            if (hasText) yield { type: 'content_block_stop', index: contentBlockIndex }
            for (const [, tc] of activeToolCalls) yield { type: 'content_block_stop', index: tc.index }
            const stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
            yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: chunk.usage?.completion_tokens ?? 0 } }
          }
        }
      }
    }
    yield { type: 'message_stop' }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

async function detectToolsSupport(baseUrl: string, apiKey: string, model: string): Promise<boolean> {
  const cache = readOpenRouterModelCache()
  const cachedAt = Number(cache?.cachedAt ?? 0)
  const models = (cache?.models ?? {}) as Record<string, unknown>
  if (Date.now() - cachedAt < 1000 * 60 * 30 && models[model]) {
    debugLog('tools_support_cache_hit', { model })
    return modelLikelySupportsTools(models[model])
  }

  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const resp = await fetch(`${baseUrl}/models`, { headers })
    if (!resp.ok) return true
    const json = (await resp.json()) as { data?: Array<{ id: string }> }
    const next: Record<string, unknown> = {}
    for (const m of json.data ?? []) next[m.id] = m
    writeOpenRouterModelCache({ cachedAt: Date.now(), models: next })
    return next[model] ? modelLikelySupportsTools(next[model]) : true
  } catch {
    return true
  }
}

interface ShimCreateParams {
  model: string
  messages: Array<Record<string, unknown>>
  system?: unknown
  tools?: Array<Record<string, unknown>>
  max_tokens: number
  stream?: boolean
  temperature?: number
  top_p?: number
  tool_choice?: unknown
  [key: string]: unknown
}

class OpenAIShimStream {
  private generator: AsyncGenerator<AnthropicStreamEvent>
  controller = new AbortController()
  constructor(generator: AsyncGenerator<AnthropicStreamEvent>) { this.generator = generator }
  async *[Symbol.asyncIterator]() { yield* this.generator }
}

class OpenAIShimMessages {
  constructor(private baseUrl: string, private apiKey: string, private defaultHeaders: Record<string, string>) {}

  create(params: ShimCreateParams, options?: { signal?: AbortSignal; headers?: Record<string, string> }) {
    const promise = (async () => {
      const effectiveModel = params.model || resolveOpenRouterModel()
      const responseData = await this._doRequest(params, effectiveModel, options)
      if (responseData.streamResponse) {
        return new OpenAIShimStream(openaiStreamToAnthropic(responseData.streamResponse, responseData.model, options?.signal))
      }
      return this._convertNonStreamingResponse(responseData.jsonResponse, responseData.model)
    })()
    ;(promise as unknown as Record<string, unknown>).withResponse = async () => ({ data: await promise, response: new Response(), request_id: makeMessageId() })
    return promise
  }

  private async _doRequest(params: ShimCreateParams, model: string, options?: { signal?: AbortSignal; headers?: Record<string, string> }) {
    const openaiMessages = convertMessages(params.messages as Array<{ role: string; message?: { role?: string; content?: unknown }; content?: unknown }>, params.system)
    const shouldStream = resolveStreamEnabled(params.stream)
    const toolsRequested = params.tools && params.tools.length > 0
    const supportsTools = toolsRequested ? await detectToolsSupport(this.baseUrl, this.apiKey, model) : true
    if (toolsRequested && !supportsTools) {
      console.error(`[openrouter] Model ${model} does not advertise tools support. Continuing without tool declarations.`)
    }

    const baseBody: Record<string, unknown> = {
      messages: openaiMessages,
      max_tokens: params.max_tokens,
      stream: shouldStream,
      ...(shouldStream ? { stream_options: { include_usage: true } } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.top_p !== undefined ? { top_p: params.top_p } : {}),
    }

    if (toolsRequested && supportsTools) {
      const converted = convertTools(params.tools as Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>)
      if (converted.length > 0) {
        baseBody.tools = converted
        const tc = params.tool_choice as { type?: string; name?: string } | undefined
        if (tc?.type === 'auto') baseBody.tool_choice = 'auto'
        else if (tc?.type === 'any') baseBody.tool_choice = 'required'
        else if (tc?.type === 'tool' && tc.name) baseBody.tool_choice = { type: 'function', function: { name: tc.name } }
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.defaultHeaders, ...(options?.headers ?? {}) }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    if (this.baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] ??= 'https://github.com/gitlawb/openclaude'
      headers['X-Title'] ??= 'openclaude-router'
    }

    const requestId = makeMessageId()
    let lastErr: Error | null = null
    for (const candidate of resolveModelFallbackChain(model)) {
      const startedAt = Date.now()
      debugLog('request_start', { requestId, model: candidate, stream: shouldStream })
      let response: Response
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...baseBody, model: candidate }), signal: options?.signal })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        lastErr = new OpenRouterShimError(`OpenRouter transport error (${candidate}): ${detail}`, { code: 'OPENROUTER_TRANSPORT_ERROR' })
        debugLog('request_network_error', { requestId, model: candidate, durationMs: Date.now() - startedAt, detail })
        continue
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown error')
        debugLog('request_failed', { requestId, model: candidate, status: response.status, durationMs: Date.now() - startedAt })
        lastErr = new OpenRouterShimError(`OpenRouter API error ${response.status} (${candidate}): ${errorBody}`, {
          code: 'OPENROUTER_UPSTREAM_ERROR',
          status: response.status,
        })
        if (!shouldRetryWithFallback(response.status)) {
          throw lastErr
        }
        continue
      }

      debugLog('request_succeeded', { requestId, model: candidate, durationMs: Date.now() - startedAt })
      if (shouldStream) return { model: candidate, streamResponse: response }
      return { model: candidate, jsonResponse: await response.json() }
    }
    throw lastErr ?? new OpenRouterShimError('OpenRouter request failed', { code: 'OPENROUTER_REQUEST_FAILED' })
  }

  private _convertNonStreamingResponse(data: { id?: string; model?: string; choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }, model: string) {
    const choice = data.choices?.[0]
    const content: Array<Record<string, unknown>> = []
    if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content })
    for (const tc of choice?.message?.tool_calls ?? []) {
      let input: unknown
      try { input = JSON.parse(tc.function.arguments) } catch { input = { raw: tc.function.arguments } }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
    }
    const stopReason = choice?.finish_reason === 'tool_calls' ? 'tool_use' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
    return { id: data.id ?? makeMessageId(), type: 'message', role: 'assistant', content, model: data.model ?? model, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  }
}

class OpenAIShimBeta { constructor(public messages: OpenAIShimMessages) {} }

export function createOpenAIShimClient(options: { defaultHeaders?: Record<string, string> }): unknown {
  const baseUrl = resolveOpenRouterBaseUrl()
  const apiKey = resolveOpenRouterApiKey()
  const beta = new OpenAIShimBeta(new OpenAIShimMessages(baseUrl, apiKey, { ...(options.defaultHeaders ?? {}) }))
  return { beta, messages: beta.messages }
}

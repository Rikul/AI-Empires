// OpenAI-compatible chat completion client used by the decision proxy.
import type { AiConnection } from '../shared/types';
import type { ChatMessage } from '../shared/ai/prompt';

export interface ChatResult { content: string; latencyMs: number }

const TIMEOUT_MS = 180_000;

function endpoint(baseUrl: string) {
  const b = baseUrl.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
}

function extractContent(json: unknown): string {
  const j = json as { choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[]; error?: { message?: string } };
  if (j?.error) throw new Error(`provider error: ${j.error.message ?? JSON.stringify(j.error)}`);
  const msg = j?.choices?.[0]?.message;
  if (!msg) throw new Error('response has no choices[0].message');
  let c = msg.content;
  if (Array.isArray(c)) c = c.map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? '')).join('');
  if (typeof c === 'string' && c.trim()) return c;
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.includes('{')) return msg.reasoning_content;
  throw new Error('empty completion');
}

export async function chat(ai: AiConnection, messages: ChatMessage[], opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<ChatResult> {
  if (!/^https?:\/\//i.test(ai.baseUrl.trim())) throw new Error('base URL must start with http:// or https://');
  if (!ai.model.trim()) throw new Error('model identifier is required');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ai.apiKey) headers.authorization = `Bearer ${ai.apiKey}`;
  // try progressively plainer request bodies for picky providers
  const variants: Record<string, unknown>[] = [
    { response_format: { type: 'json_object' }, temperature: 0.4 },
    { temperature: 0.4 },
    {},
  ];
  const started = Date.now();
  let lastErr = '';
  for (const extra of variants) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(endpoint(ai.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: ai.model.trim(), messages, ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}), ...extra }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${text.slice(0, 400)}`;
        // only retry with a simpler body on request-shape errors
        if (res.status === 400 || res.status === 422) continue;
        throw new Error(lastErr);
      }
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new Error(`non-JSON response: ${text.slice(0, 200)}`); }
      return { content: extractContent(json), latencyMs: Date.now() - started };
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error(opts.signal?.aborted ? 'request cancelled' : `timed out after ${TIMEOUT_MS / 1000}s`);
      if ((e as Error).message === 'fetch failed') {
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        throw new Error(`could not connect to ${endpoint(ai.baseUrl)} (${cause?.code ?? cause?.message ?? 'network error'})`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new Error(lastErr || 'request failed');
}

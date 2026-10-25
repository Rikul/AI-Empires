// AI Empires server: SQLite persistence, LLM decision proxy, import/export and static hosting.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, redactConfig } from './db';
import { chat } from './llm';
import { exportRecord, validateRecord } from '../shared/record';
import { newRecord } from '../shared/engine';
import { validateConfigOnly } from './validate';
import { extractObservation, mockDecide } from '../shared/ai/mock';
import type { AiConnection, MatchConfig, MatchRecord, PlayerId } from '../shared/types';
import type { ChatMessage } from '../shared/ai/prompt';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 8080);
const DB_FILE = process.env.AI_EMPIRES_DB ?? path.join(ROOT, 'data', 'ai-empires.db');
const STATIC_DIR = path.join(ROOT, 'dist', 'client');
const MAX_BODY = 200 * 1024 * 1024;

const store = new Store(DB_FILE);

class HttpError extends Error { constructor(public status: number, msg: string, public extra?: unknown) { super(msg); } }

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const text = await readBody(req);
  try { return JSON.parse(text) as T; } catch { throw new HttpError(400, 'invalid JSON body'); }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

function redactRecord(r: MatchRecord): MatchRecord {
  return { ...r, config: redactConfig(r.config) };
}

function safeFileName(s: string) { return s.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60) || 'match'; }

const inflight = new Map<string, AbortController>();

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: string[], url: URL) => Promise<void>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, re: RegExp, h: Handler) => routes.push([method, re, h]);

route('GET', /^\/api\/health$/, async (_q, res) => send(res, 200, { ok: true }));

route('GET', /^\/api\/matches$/, async (_q, res) => send(res, 200, store.list()));

route('POST', /^\/api\/matches$/, async (req, res) => {
  const body = await readJson<{ config: MatchConfig; name?: string }>(req);
  const errors = validateConfigOnly(body.config);
  if (errors.length) throw new HttpError(400, 'invalid match configuration', { errors });
  const id = randomUUID();
  const name = String(body.name ?? '').trim().slice(0, 120) || defaultName(body.config);
  const rec = newRecord(body.config, id, name);
  store.insert(rec);
  send(res, 201, redactRecord(rec));
});

function defaultName(c: MatchConfig) {
  const who = c.players.map((p) => (p.kind === 'human' ? p.name || 'Player' : p.ai.name || p.ai.model)).join(' vs ');
  return `${who} — ${c.mapSize} ${c.biome.replace(/([a-z])([A-Z])/g, '$1 $2')}`;
}

route('GET', /^\/api\/matches\/([\w-]+)$/, async (_q, res, [id]) => {
  const m = store.get(id);
  if (!m) throw new HttpError(404, 'match not found');
  send(res, 200, { record: redactRecord(m.record), snapshot: m.snapshot });
});

route('PUT', /^\/api\/matches\/([\w-]+)$/, async (req, res, [id]) => {
  if (!store.exists(id)) throw new HttpError(404, 'match not found');
  const b = await readJson<{ name?: string; status: MatchRecord['status']; currentTick: number; result: MatchRecord['result']; commands: MatchRecord['commands']; decisions: MatchRecord['decisions']; checksums: MatchRecord['checksums']; snapshot?: unknown }>(req);
  if (!['running', 'paused', 'completed'].includes(b.status)) throw new HttpError(400, 'invalid status');
  if (!Number.isInteger(b.currentTick) || b.currentTick < 0) throw new HttpError(400, 'invalid currentTick');
  if (!Array.isArray(b.commands) || !Array.isArray(b.decisions) || !Array.isArray(b.checksums)) throw new HttpError(400, 'invalid log');
  const updatedAt = store.update(id, {
    name: typeof b.name === 'string' ? b.name.slice(0, 120) : undefined,
    status: b.status, currentTick: b.currentTick, result: b.result ?? null,
    log: { commands: b.commands, decisions: b.decisions, checksums: b.checksums }, snapshot: b.snapshot,
  });
  send(res, 200, { ok: true, updatedAt });
});

route('PATCH', /^\/api\/matches\/([\w-]+)$/, async (req, res, [id]) => {
  if (!store.exists(id)) throw new HttpError(404, 'match not found');
  const b = await readJson<{ name?: string }>(req);
  if (typeof b.name === 'string' && b.name.trim()) store.rename(id, b.name.trim().slice(0, 120));
  send(res, 200, { ok: true });
});

route('DELETE', /^\/api\/matches\/([\w-]+)$/, async (_q, res, [id]) => {
  store.delete(id);
  send(res, 200, { ok: true });
});

route('GET', /^\/api\/matches\/([\w-]+)\/export$/, async (_q, res, [id]) => {
  const m = store.get(id);
  if (!m) throw new HttpError(404, 'match not found');
  const out = exportRecord(m.record);
  send(res, 200, JSON.stringify(out), { 'content-disposition': `attachment; filename="ai-empires-${safeFileName(m.record.name)}-${m.record.status}.json"` });
});

route('POST', /^\/api\/import$/, async (req, res) => {
  const text = await readBody(req);
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { throw new HttpError(400, 'import rejected', { errors: [`file is not valid JSON: ${(e as Error).message}`] }); }
  const t0 = Date.now();
  const v = validateRecord(data);
  if (!v.ok || !v.record) throw new HttpError(400, 'import rejected', { errors: v.errors });
  const rec = v.record;
  if (store.exists(rec.id)) rec.id = randomUUID();
  rec.name = rec.name.endsWith('(imported)') ? rec.name : `${rec.name} (imported)`;
  // a running match is stored as paused; it can be resumed like any saved match
  if (rec.status === 'running') rec.status = 'paused';
  store.insert(rec);
  send(res, 201, { ok: true, id: rec.id, verifiedTicks: rec.currentTick, ms: Date.now() - t0 });
});

route('POST', /^\/api\/llm\/chat$/, async (req, res) => {
  const b = await readJson<{ matchId: string; player: PlayerId; messages: ChatMessage[]; requestId?: string }>(req);
  const cfg = store.getConfig(b.matchId);
  if (!cfg) throw new HttpError(404, 'match not found');
  const slot = cfg.players[b.player];
  if (!slot || slot.kind !== 'ai') throw new HttpError(400, 'that player is not controlled by an AI');
  if (!Array.isArray(b.messages)) throw new HttpError(400, 'messages required');
  const ctrl = new AbortController();
  const key = b.requestId ?? randomUUID();
  inflight.set(key, ctrl);
  try {
    const r = await chat(slot.ai, b.messages, { signal: ctrl.signal });
    send(res, 200, r);
  } catch (e) {
    send(res, 502, { error: (e as Error).message });
  } finally {
    inflight.delete(key);
  }
});

route('POST', /^\/api\/llm\/test$/, async (req, res) => {
  const b = await readJson<{ ai: AiConnection }>(req);
  try {
    const r = await chat(b.ai, [
      { role: 'system', content: 'You are a connection test. Reply with JSON only.' },
      { role: 'user', content: 'Reply with {"ok": true} as JSON.' },
    ], { maxTokens: 300 });
    send(res, 200, { ok: true, latencyMs: r.latencyMs, content: r.content.slice(0, 300) });
  } catch (e) {
    send(res, 200, { ok: false, error: (e as Error).message });
  }
});

// Built-in scripted commander exposed as an OpenAI-compatible endpoint (for testing without an LLM).
route('GET', /^\/mock\/v1\/models$/, async (_q, res) => send(res, 200, { object: 'list', data: [{ id: 'scripted-mock', object: 'model' }] }));
route('POST', /^\/mock\/v1\/chat\/completions$/, async (req, res) => {
  const b = await readJson<{ model?: string; messages?: ChatMessage[] }>(req);
  const last = b.messages?.[b.messages.length - 1]?.content ?? '';
  const obs = extractObservation(String(last));
  const content = obs ? JSON.stringify(mockDecide(obs, `${b.model ?? 'mock'}|${obs.you}`)) : '{"ok": true}';
  send(res, 200, {
    id: `mock-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: b.model ?? 'scripted-mock',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function serveStatic(res: http.ServerResponse, urlPath: string) {
  let p = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(STATIC_DIR, p);
  if (!file.startsWith(STATIC_DIR)) { send(res, 403, { error: 'forbidden' }); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC_DIR, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('Client not built. Run "npm run build" (or "npm start").');
    return;
  }
  p = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[p] ?? 'application/octet-stream', 'cache-control': p === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    for (const [method, re, h] of routes) {
      if (method !== req.method) continue;
      const m = url.pathname.match(re);
      if (m) { await h(req, res, m.slice(1), url); return; }
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mock/')) throw new HttpError(404, 'not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    serveStatic(res, url.pathname);
  } catch (e) {
    const err = e as HttpError;
    const status = err.status ?? 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: err.message, ...(err.extra as object ?? {}) });
    else res.end();
  }
});

server.requestTimeout = 0;
server.listen(PORT, () => {
  console.log(`AI Empires running at http://localhost:${PORT}  (database: ${DB_FILE})`);
});

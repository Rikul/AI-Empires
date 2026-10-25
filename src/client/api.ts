import type { AiConnection, MatchConfig, MatchRecord, MatchResult, MatchStatus, PlayerId } from '../shared/types';
import type { ChatMessage } from '../shared/ai/prompt';
import type { SerializedState } from '../shared/serialize';

export interface MatchSummary {
  id: string;
  name: string;
  mode: string;
  status: MatchStatus;
  createdAt: string;
  updatedAt: string;
  currentTick: number;
  config: MatchConfig;
  result: MatchResult | null;
}

async function j<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok) {
    const d = data as { error?: string; errors?: string[] };
    const err = new Error(d.error ?? `HTTP ${res.status}`) as Error & { errors?: string[] };
    err.errors = d.errors;
    throw err;
  }
  return data as T;
}

export const api = {
  list: () => fetch('/api/matches').then((r) => j<MatchSummary[]>(r)),
  create: (config: MatchConfig, name?: string) =>
    fetch('/api/matches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config, name }) }).then((r) => j<MatchRecord>(r)),
  get: (id: string) => fetch(`/api/matches/${id}`).then((r) => j<{ record: MatchRecord; snapshot: SerializedState | null }>(r)),
  save: (id: string, body: { status: MatchStatus; currentTick: number; result: MatchResult | null; commands: MatchRecord['commands']; decisions: MatchRecord['decisions']; checksums: MatchRecord['checksums']; snapshot?: SerializedState }) =>
    fetch(`/api/matches/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: false }).then((r) => j<{ ok: boolean; updatedAt: string }>(r)),
  rename: (id: string, name: string) => fetch(`/api/matches/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => j(r)),
  remove: (id: string) => fetch(`/api/matches/${id}`, { method: 'DELETE' }).then((r) => j(r)),
  exportUrl: (id: string) => `/api/matches/${id}/export`,
  import: (text: string) => fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text }).then((r) => j<{ ok: boolean; id: string; verifiedTicks: number; ms: number }>(r)),
  chat: (matchId: string, player: PlayerId, messages: ChatMessage[]) =>
    fetch('/api/llm/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matchId, player, messages }) }).then((r) => j<{ content: string; latencyMs: number }>(r)),
  test: (ai: AiConnection) =>
    fetch('/api/llm/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ai }) }).then((r) => j<{ ok: boolean; latencyMs?: number; content?: string; error?: string }>(r)),
};

/** Trigger a browser download of a URL. */
export function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

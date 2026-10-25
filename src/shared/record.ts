// Versioned match file format: export helpers and strict import validation.
import { FORMAT_VERSION, verifyRecord } from './engine';
import { BIOMES, BUILDING_TYPES, GENERATION_VERSION, MAP_SIZES, RULES_VERSION, TECH_TYPES, TICK_RATE, UNIT_TYPES } from './rules';
import type { AiCommand, Command, MatchConfig, MatchRecord, PlayerSlot } from './types';

/** Copy without secrets (API keys are never exported). */
export function exportRecord(r: MatchRecord): MatchRecord {
  return {
    ...r,
    config: {
      ...r.config,
      players: r.config.players.map((p) => (p.kind === 'ai' ? { kind: 'ai', ai: { name: p.ai.name, baseUrl: p.ai.baseUrl, model: p.ai.model } } : { ...p })) as [PlayerSlot, PlayerSlot],
    },
  };
}

class V {
  errors: string[] = [];
  fail(path: string, msg: string) { if (this.errors.length < 50) this.errors.push(`${path}: ${msg}`); return false; }
  obj(v: unknown, path: string): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? true : this.fail(path, 'must be an object');
  }
  str(v: unknown, path: string, max = 1000): v is string {
    return typeof v === 'string' && v.length <= max ? true : this.fail(path, `must be a string (max ${max} chars)`);
  }
  int(v: unknown, path: string, min: number, max: number): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? true : this.fail(path, `must be an integer in [${min}, ${max}]`);
  }
  num(v: unknown, path: string, min: number, max: number): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? true : this.fail(path, `must be a number in [${min}, ${max}]`);
  }
  oneOf<T>(v: unknown, path: string, opts: readonly T[]): v is T {
    return opts.includes(v as T) ? true : this.fail(path, `must be one of ${opts.join(', ')}`);
  }
  ids(v: unknown, path: string): v is number[] {
    if (!Array.isArray(v) || v.length > 1000) return this.fail(path, 'must be an array of entity ids');
    for (let i = 0; i < v.length; i++) if (!Number.isInteger(v[i]) || v[i] < 0 || v[i] > 1e9) return this.fail(`${path}[${i}]`, 'invalid id');
    return true;
  }
  keys(o: Record<string, unknown>, path: string, allowed: string[]) {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) this.fail(path, `unexpected field "${k}"`);
  }
  iso(v: unknown, path: string) {
    if (!this.str(v, path, 40)) return false;
    return Number.isNaN(Date.parse(v as string)) ? this.fail(path, 'must be an ISO date') : true;
  }
}

function validateSlot(v: V, s: unknown, path: string): boolean {
  if (!v.obj(s, path)) return false;
  if (s.kind === 'human') {
    v.keys(s, path, ['kind', 'name']);
    return v.str(s.name, `${path}.name`, 60);
  }
  if (s.kind === 'ai') {
    v.keys(s, path, ['kind', 'ai']);
    if (!v.obj(s.ai, `${path}.ai`)) return false;
    const ai = s.ai;
    v.keys(ai, `${path}.ai`, ['name', 'baseUrl', 'model', 'apiKey']);
    v.str(ai.name, `${path}.ai.name`, 60);
    v.str(ai.baseUrl, `${path}.ai.baseUrl`, 500);
    v.str(ai.model, `${path}.ai.model`, 200);
    if (ai.apiKey !== undefined) v.str(ai.apiKey, `${path}.ai.apiKey`, 500);
    return true;
  }
  return v.fail(`${path}.kind`, 'must be "human" or "ai"');
}

export function validateConfig(v: V, c: unknown, path = 'config'): c is MatchConfig {
  if (!v.obj(c, path)) return false;
  v.keys(c, path, ['mode', 'mapSize', 'biome', 'seed', 'popCap', 'timeLimitMin', 'generationVersion', 'rulesVersion', 'decisionIntervalSec', 'decisionWindowSec', 'players']);
  v.oneOf(c.mode, `${path}.mode`, ['pva', 'ava']);
  v.oneOf(c.mapSize, `${path}.mapSize`, Object.keys(MAP_SIZES));
  v.oneOf(c.biome, `${path}.biome`, BIOMES);
  v.str(c.seed, `${path}.seed`, 100);
  v.int(c.popCap, `${path}.popCap`, 10, 500);
  v.int(c.timeLimitMin, `${path}.timeLimitMin`, 1, 240);
  if (c.generationVersion !== GENERATION_VERSION) v.fail(`${path}.generationVersion`, `unsupported (this build supports ${GENERATION_VERSION})`);
  if (c.rulesVersion !== RULES_VERSION) v.fail(`${path}.rulesVersion`, `unsupported (this build supports ${RULES_VERSION})`);
  v.num(c.decisionIntervalSec, `${path}.decisionIntervalSec`, 2, 600);
  if (v.num(c.decisionWindowSec, `${path}.decisionWindowSec`, 0.1, 600) && typeof c.decisionIntervalSec === 'number' && (c.decisionWindowSec as number) > c.decisionIntervalSec) {
    v.fail(`${path}.decisionWindowSec`, 'must not exceed decisionIntervalSec');
  }
  if (!Array.isArray(c.players) || c.players.length !== 2) return v.fail(`${path}.players`, 'must have exactly 2 entries');
  c.players.forEach((s, i) => validateSlot(v, s, `${path}.players[${i}]`));
  const kinds = (c.players as { kind?: string }[]).map((p) => p?.kind);
  if (c.mode === 'pva' && !(kinds[0] === 'human' && kinds[1] === 'ai')) v.fail(`${path}.players`, 'Player vs AI requires player 1 human and player 2 AI');
  if (c.mode === 'ava' && !(kinds[0] === 'ai' && kinds[1] === 'ai')) v.fail(`${path}.players`, 'AI vs AI requires two AI players');
  return true;
}

const pointKeys = ['x', 'y'];
function validateCommand(v: V, c: unknown, path: string): c is Command {
  if (!v.obj(c, path)) return false;
  const coord = (k: string) => v.num(c[k], `${path}.${k}`, -1, 1000);
  switch (c.t) {
    case 'move': v.keys(c, path, ['t', 'units', ...pointKeys, 'attack']); v.ids(c.units, `${path}.units`); coord('x'); coord('y'); if (c.attack !== undefined && typeof c.attack !== 'boolean') v.fail(`${path}.attack`, 'must be boolean'); break;
    case 'attack': v.keys(c, path, ['t', 'units', 'target']); v.ids(c.units, `${path}.units`); v.int(c.target, `${path}.target`, 0, 1e9); break;
    case 'gather': v.keys(c, path, ['t', 'units', ...pointKeys]); v.ids(c.units, `${path}.units`); coord('x'); coord('y'); break;
    case 'build':
      v.keys(c, path, ['t', 'units', 'building', 'x', 'y', 'x2', 'y2', 'queue']); v.ids(c.units, `${path}.units`); v.oneOf(c.building, `${path}.building`, BUILDING_TYPES); coord('x'); coord('y');
      if (c.x2 !== undefined) coord('x2');
      if (c.y2 !== undefined) coord('y2');
      if (c.queue !== undefined && typeof c.queue !== 'boolean') v.fail(`${path}.queue`, 'must be boolean');
      break;
    case 'assist': v.keys(c, path, ['t', 'units', 'target']); v.ids(c.units, `${path}.units`); v.int(c.target, `${path}.target`, 0, 1e9); break;
    case 'train': v.keys(c, path, ['t', 'building', 'unit', 'count']); v.int(c.building, `${path}.building`, 0, 1e9); v.oneOf(c.unit, `${path}.unit`, UNIT_TYPES); v.int(c.count, `${path}.count`, 1, 10); break;
    case 'research': v.keys(c, path, ['t', 'building', 'tech']); v.int(c.building, `${path}.building`, 0, 1e9); v.oneOf(c.tech, `${path}.tech`, TECH_TYPES); break;
    case 'cancel': v.keys(c, path, ['t', 'building', 'index']); v.int(c.building, `${path}.building`, 0, 1e9); v.int(c.index, `${path}.index`, 0, 100); break;
    case 'stop': v.keys(c, path, ['t', 'units']); v.ids(c.units, `${path}.units`); break;
    case 'guard': v.keys(c, path, ['t', 'units', 'x', 'y', 'r']); v.ids(c.units, `${path}.units`); coord('x'); coord('y'); v.num(c.r, `${path}.r`, 0, 100); break;
    case 'explore': v.keys(c, path, ['t', 'units']); v.ids(c.units, `${path}.units`); break;
    case 'rally': v.keys(c, path, ['t', 'building', 'x', 'y']); v.int(c.building, `${path}.building`, 0, 1e9); coord('x'); coord('y'); break;
    case 'delete': v.keys(c, path, ['t', 'ids']); v.ids(c.ids, `${path}.ids`); break;
    case 'ai':
      v.keys(c, path, ['t', 'plan', 'cmds']);
      v.str(c.plan, `${path}.plan`, 2000);
      if (!Array.isArray(c.cmds) || c.cmds.length > 100) return v.fail(`${path}.cmds`, 'must be an array (max 100)');
      c.cmds.forEach((x, i) => validateAiCommand(v, x, `${path}.cmds[${i}]`));
      break;
    default:
      return v.fail(`${path}.t`, `unknown command type ${JSON.stringify(c.t)}`);
  }
  return true;
}

const AI_TYPES = ['gather', 'build', 'train', 'research', 'explore', 'move', 'attack', 'defend', 'group', 'stop', 'rally'];
function validateAiCommand(v: V, c: unknown, path: string): c is AiCommand {
  if (!v.obj(c, path)) return false;
  v.oneOf(c.type, `${path}.type`, AI_TYPES);
  // free-form fields from the model must be plain JSON values of bounded size
  const size = JSON.stringify(c).length;
  if (size > 4000) v.fail(path, 'command too large');
  return true;
}

export interface ValidationResult { ok: boolean; errors: string[]; record?: MatchRecord }

/** Full structural validation followed by a deterministic re-simulation check. */
export function validateRecord(data: unknown, opts: { verify?: boolean } = {}): ValidationResult {
  const v = new V();
  if (!v.obj(data, 'file')) return { ok: false, errors: v.errors };
  const r = data;
  v.keys(r, 'file', ['format', 'formatVersion', 'id', 'name', 'createdAt', 'updatedAt', 'status', 'config', 'currentTick', 'commands', 'decisions', 'checksums', 'result']);
  if (r.format !== 'ai-empires-match') v.fail('format', 'not an AI Empires match file');
  if (r.formatVersion !== FORMAT_VERSION) v.fail('formatVersion', `unsupported version ${JSON.stringify(r.formatVersion)} (supported: ${FORMAT_VERSION})`);
  v.str(r.id, 'id', 64);
  v.str(r.name, 'name', 200);
  v.iso(r.createdAt, 'createdAt');
  v.iso(r.updatedAt, 'updatedAt');
  v.oneOf(r.status, 'status', ['running', 'paused', 'completed']);
  const cfgOk = validateConfig(v, r.config);
  const limit = cfgOk && typeof (r.config as MatchConfig).timeLimitMin === 'number' ? Math.round((r.config as MatchConfig).timeLimitMin * 60 * TICK_RATE) : 240 * 60 * TICK_RATE;
  v.int(r.currentTick, 'currentTick', 0, limit);
  const cur = typeof r.currentTick === 'number' ? r.currentTick : 0;
  const players = cfgOk ? (r.config as MatchConfig).players : null;
  if (!Array.isArray(r.commands)) v.fail('commands', 'must be an array');
  else {
    let last = 0;
    r.commands.forEach((lc, i) => {
      const p = `commands[${i}]`;
      if (!v.obj(lc, p)) return;
      v.keys(lc, p, ['tick', 'player', 'source', 'cmd']);
      if (v.int(lc.tick, `${p}.tick`, 0, limit)) {
        if ((lc.tick as number) < last) v.fail(`${p}.tick`, 'commands must be sorted by tick');
        last = lc.tick as number;
      }
      v.oneOf(lc.player, `${p}.player`, [0, 1]);
      v.oneOf(lc.source, `${p}.source`, ['human', 'ai']);
      if (validateCommand(v, lc.cmd, `${p}.cmd`) && players && (lc.player === 0 || lc.player === 1)) {
        const slot = players[lc.player as 0 | 1];
        const isAi = (lc.cmd as Command).t === 'ai';
        if (slot?.kind === 'human' && (lc.source !== 'human' || isAi)) v.fail(p, 'AI commands are not allowed for a human player');
        if (slot?.kind === 'ai' && (lc.source !== 'ai' || !isAi)) v.fail(p, 'only AI decisions are allowed for an AI player');
      }
    });
  }
  if (!Array.isArray(r.decisions)) v.fail('decisions', 'must be an array');
  else r.decisions.forEach((d, i) => {
    const p = `decisions[${i}]`;
    if (!v.obj(d, p)) return;
    v.keys(d, p, ['player', 'requestTick', 'applyTick', 'latencyMs', 'ok', 'error', 'thoughts', 'plan', 'raw', 'commands']);
    v.oneOf(d.player, `${p}.player`, [0, 1]);
    if (players && (d.player === 0 || d.player === 1) && players[d.player].kind !== 'ai') v.fail(p, 'decision recorded for a human player');
    v.int(d.requestTick, `${p}.requestTick`, 0, limit);
    v.int(d.applyTick, `${p}.applyTick`, 0, limit + 6000);
    v.num(d.latencyMs, `${p}.latencyMs`, 0, 1e8);
    if (typeof d.ok !== 'boolean') v.fail(`${p}.ok`, 'must be boolean');
    for (const k of ['error', 'thoughts', 'plan', 'raw']) if (d[k] !== undefined) v.str(d[k], `${p}.${k}`, 100000);
    if (!Array.isArray(d.commands)) v.fail(`${p}.commands`, 'must be an array');
    else d.commands.forEach((x, j) => validateAiCommand(v, x, `${p}.commands[${j}]`));
  });
  if (!Array.isArray(r.checksums)) v.fail('checksums', 'must be an array');
  else {
    let last = -1;
    r.checksums.forEach((c, i) => {
      const p = `checksums[${i}]`;
      if (!v.obj(c, p)) return;
      v.keys(c, p, ['tick', 'hash']);
      if (v.int(c.tick, `${p}.tick`, 1, cur)) { if ((c.tick as number) <= last) v.fail(p, 'checksums must be strictly increasing'); last = c.tick as number; }
      if (typeof c.hash !== 'string' || !/^[0-9a-f]{8}$/.test(c.hash)) v.fail(`${p}.hash`, 'must be 8 hex digits');
    });
  }
  if (r.result !== null) {
    if (v.obj(r.result, 'result')) {
      const res = r.result;
      v.keys(res, 'result', ['winner', 'reason', 'scores', 'tick']);
      if (res.winner !== null) v.oneOf(res.winner, 'result.winner', [0, 1]);
      v.oneOf(res.reason, 'result.reason', ['conquest', 'time']);
      if (!Array.isArray(res.scores) || res.scores.length !== 2 || !res.scores.every((x) => typeof x === 'number' && Number.isFinite(x))) v.fail('result.scores', 'must be two numbers');
      if (v.int(res.tick, 'result.tick', 1, limit) && res.tick !== cur) v.fail('result.tick', 'must equal currentTick');
    }
  }
  if ((r.status === 'completed') !== (r.result !== null && r.result !== undefined)) v.fail('status', 'status "completed" must match the presence of a result');
  if (v.errors.length) return { ok: false, errors: v.errors };
  const record = r as unknown as MatchRecord;
  if (opts.verify !== false) {
    if (record.currentTick > 0 && record.checksums.length === 0 && record.currentTick >= 600) return { ok: false, errors: ['checksums: missing for a match longer than one minute'] };
    try {
      const res = verifyRecord(record);
      if (!res.ok) return { ok: false, errors: [`replay verification failed: ${res.error}`] };
    } catch (e) {
      return { ok: false, errors: [`replay verification crashed: ${(e as Error).message}`] };
    }
  }
  return { ok: true, errors: [], record };
}

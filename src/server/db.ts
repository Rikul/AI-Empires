import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { MatchConfig, MatchRecord, MatchResult, MatchStatus } from '../shared/types';

export interface MatchRow {
  id: string;
  name: string;
  mode: string;
  status: MatchStatus;
  created_at: string;
  updated_at: string;
  current_tick: number;
  config_json: string;
  result_json: string | null;
  log_gz: Buffer;
  snapshot_gz: Buffer | null;
  snapshot_tick: number | null;
}

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

type Log = Pick<MatchRecord, 'commands' | 'decisions' | 'checksums'>;

const gz = (s: string) => zlib.gzipSync(Buffer.from(s, 'utf8'), { level: 6 });
const gunz = (b: Buffer) => zlib.gunzipSync(b).toString('utf8');

/** API keys never leave the server once stored. */
export function redactConfig(c: MatchConfig): MatchConfig {
  return {
    ...c,
    players: c.players.map((p) => (p.kind === 'ai' ? { kind: 'ai', ai: { name: p.ai.name, baseUrl: p.ai.baseUrl, model: p.ai.model, apiKey: p.ai.apiKey ? '********' : undefined } } : p)) as MatchConfig['players'],
  };
}

export class Store {
  db: Database.Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        current_tick INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL,
        result_json TEXT,
        log_gz BLOB NOT NULL,
        snapshot_gz BLOB,
        snapshot_tick INTEGER
      );
      CREATE INDEX IF NOT EXISTS matches_updated ON matches(updated_at DESC);
    `);
  }

  list(): MatchSummary[] {
    const rows = this.db.prepare('SELECT id,name,mode,status,created_at,updated_at,current_tick,config_json,result_json FROM matches ORDER BY updated_at DESC').all() as MatchRow[];
    return rows.map((r) => ({
      id: r.id, name: r.name, mode: r.mode, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
      currentTick: r.current_tick, config: redactConfig(JSON.parse(r.config_json)), result: r.result_json ? JSON.parse(r.result_json) : null,
    }));
  }

  exists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM matches WHERE id=?').get(id);
  }

  insert(rec: MatchRecord, snapshot?: unknown) {
    const log: Log = { commands: rec.commands, decisions: rec.decisions, checksums: rec.checksums };
    const config = { ...rec.config, decisionIntervalSec: -rec.config.decisionIntervalSec };
    this.db.prepare(`INSERT INTO matches (id,name,mode,status,created_at,updated_at,current_tick,config_json,result_json,log_gz,snapshot_gz,snapshot_tick)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      rec.id, rec.name, rec.config.mode, rec.status, rec.createdAt, rec.updatedAt, rec.currentTick, JSON.stringify(config),
      rec.result ? JSON.stringify(rec.result) : null, gz(JSON.stringify(log)),
      snapshot ? gz(JSON.stringify(snapshot)) : null, snapshot ? (snapshot as { tick: number }).tick : null,
    );
  }

  /** Full record including secrets (server-side use only). */
  get(id: string): { record: MatchRecord; snapshot: unknown | null } | null {
    const r = this.db.prepare('SELECT * FROM matches WHERE id=?').get(id) as MatchRow | undefined;
    if (!r) return null;
    const log = JSON.parse(gunz(r.log_gz)) as Log;
    const record: MatchRecord = {
      format: 'ai-empires-match', formatVersion: 1, id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at,
      status: r.status, config: JSON.parse(r.config_json), currentTick: r.current_tick,
      commands: log.commands, decisions: log.decisions, checksums: log.checksums, result: r.result_json ? JSON.parse(r.result_json) : null,
    };
    return { record, snapshot: r.snapshot_gz ? JSON.parse(gunz(r.snapshot_gz)) : null };
  }

  getConfig(id: string): MatchConfig | null {
    const r = this.db.prepare('SELECT config_json FROM matches WHERE id=?').get(id) as { config_json: string } | undefined;
    return r ? JSON.parse(r.config_json) : null;
  }

  update(id: string, u: { name?: string; status: MatchStatus; currentTick: number; result: MatchResult | null; log: Log; snapshot?: unknown }) {
    const now = new Date().toISOString();
    if (u.snapshot) {
      this.db.prepare('UPDATE matches SET status=?, current_tick=?, result_json=?, log_gz=?, snapshot_gz=?, snapshot_tick=?, updated_at=?, name=COALESCE(?, name) WHERE id=?').run(
        u.status, u.currentTick, u.result ? JSON.stringify(u.result) : null, gz(JSON.stringify(u.log)), gz(JSON.stringify(u.snapshot)),
        (u.snapshot as { tick: number }).tick, now, u.name ?? null, id,
      );
    } else {
      this.db.prepare('UPDATE matches SET status=?, current_tick=?, result_json=?, log_gz=?, updated_at=?, name=COALESCE(?, name) WHERE id=?').run(
        u.status, u.currentTick, u.result ? JSON.stringify(u.result) : null, gz(JSON.stringify(u.log)), now, u.name ?? null, id,
      );
    }
    return now;
  }

  rename(id: string, name: string) {
    this.db.prepare('UPDATE matches SET name=? WHERE id=?').run(name, id);
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM matches WHERE id=?').run(id);
  }
}

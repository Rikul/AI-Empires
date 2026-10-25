// MatchEngine: drives the simulation from a match record's command log. Used for live
// play (commands are appended as they are issued), history review and replays.
import { cloneState, hashState } from './serialize';
import { createInitialState, step, timeLimitTicks } from './sim';
import { GENERATION_VERSION, RULES_VERSION, TICK_RATE } from './rules';
import type { Command, GameState, LoggedCommand, MatchConfig, MatchRecord, PlayerId } from './types';

export const FORMAT_VERSION = 1;
export const CHECKSUM_INTERVAL = 600; // ticks (one simulated minute)
export const SNAPSHOT_INTERVAL = 300; // ticks between in-memory history snapshots

export function newRecord(config: MatchConfig, id: string, name: string): MatchRecord {
  const now = new Date().toISOString();
  return {
    format: 'ai-empires-match',
    formatVersion: FORMAT_VERSION,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    status: 'paused',
    config: { ...config, generationVersion: GENERATION_VERSION, rulesVersion: RULES_VERSION },
    currentTick: 0,
    commands: [],
    decisions: [],
    checksums: [],
    result: null,
  };
}

export function decisionIntervalTicks(c: MatchConfig) { return Math.max(1, Math.round(c.decisionIntervalSec * TICK_RATE)); }
export function decisionWindowTicks(c: MatchConfig) { return Math.max(1, Math.round(c.decisionWindowSec * TICK_RATE)); }

/** Insert keeping the log sorted by tick (stable: after existing entries of the same tick). */
export function insertCommand(log: LoggedCommand[], c: LoggedCommand) {
  let i = log.length;
  while (i > 0 && log[i - 1].tick > c.tick) i--;
  log.splice(i, 0, c);
}

export type CheckMode = 'record' | 'verify' | 'none';

export class MatchEngine {
  state: GameState;
  private cmdIdx = 0;
  snapshots = new Map<number, GameState>();
  mismatch: string | null = null;

  constructor(public record: MatchRecord, public checkMode: CheckMode, start?: GameState) {
    this.state = start ?? createInitialState(record.config);
    this.snapshots.set(0, start ? createInitialState(record.config) : cloneState(this.state));
    if (start && start.tick > 0) this.snapshots.set(start.tick, cloneState(start));
    this.seekIndex();
  }

  private seekIndex() {
    const log = this.record.commands;
    let lo = 0, hi = log.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (log[m].tick < this.state.tick) lo = m + 1; else hi = m;
    }
    this.cmdIdx = lo;
  }

  get tick() { return this.state.tick; }
  get finished() { return !!this.state.result; }

  /** Append a command to be executed at the current tick (human orders). */
  issue(player: PlayerId, cmd: Command, source: 'human' | 'ai' = 'human') {
    insertCommand(this.record.commands, { tick: this.state.tick, player, source, cmd });
  }

  stepOnce(): void {
    if (this.state.result) return;
    const log = this.record.commands;
    // commands are only ever inserted at or after the current tick
    while (this.cmdIdx > 0 && log[this.cmdIdx - 1].tick >= this.state.tick) this.cmdIdx--;
    const cmds: { player: PlayerId; cmd: Command }[] = [];
    while (this.cmdIdx < log.length && log[this.cmdIdx].tick === this.state.tick) {
      cmds.push(log[this.cmdIdx]);
      this.cmdIdx++;
    }
    step(this.state, cmds);
    const t = this.state.tick;
    if (t % SNAPSHOT_INTERVAL === 0 && !this.snapshots.has(t)) this.snapshots.set(t, cloneState(this.state));
    if (t % CHECKSUM_INTERVAL === 0 || this.state.result) this.checksum();
  }

  private checksum() {
    const t = this.state.tick;
    if (this.checkMode === 'record') {
      const cs = this.record.checksums;
      while (cs.length && cs[cs.length - 1].tick >= t) cs.pop();
      cs.push({ tick: t, hash: hashState(this.state) });
    } else if (this.checkMode === 'verify' && !this.mismatch) {
      const want = this.record.checksums.find((c) => c.tick === t);
      if (want) {
        const got = hashState(this.state);
        if (got !== want.hash) this.mismatch = `checksum mismatch at tick ${t}: expected ${want.hash}, got ${got}`;
      }
    }
  }

  /** Jump to an earlier or later tick using the nearest snapshot and re-simulation. */
  seek(tick: number, maxTick = this.record.currentTick): void {
    const target = Math.max(0, Math.min(tick, maxTick));
    let best = -1;
    for (const k of this.snapshots.keys()) if (k <= target && k > best) best = k;
    if (best < 0 || (this.state.tick <= target && this.state.tick > best)) {
      // continue forward from the current state
    } else {
      this.state = cloneState(this.snapshots.get(best)!);
      this.seekIndex();
    }
    while (this.state.tick < target && !this.state.result) this.stepOnce();
  }

  timeLimitTicks() { return timeLimitTicks(this.record.config); }
}

/** Re-simulate an entire record and compare checksums and the final result. */
export function verifyRecord(record: MatchRecord, onProgress?: (tick: number) => void): { ok: boolean; error?: string; state: GameState } {
  const eng = new MatchEngine({ ...record, commands: record.commands }, 'verify');
  const end = record.currentTick;
  while (eng.tick < end && !eng.finished) {
    eng.stepOnce();
    if (eng.mismatch) return { ok: false, error: eng.mismatch, state: eng.state };
    if (onProgress && eng.tick % 1000 === 0) onProgress(eng.tick);
  }
  if (eng.tick !== end) return { ok: false, error: `match ended at tick ${eng.tick} but record says ${end}`, state: eng.state };
  const r = eng.state.result, w = record.result;
  if (!!r !== !!w) return { ok: false, error: 'final result does not match the recorded result', state: eng.state };
  if (r && w && (r.winner !== w.winner || r.reason !== w.reason || r.tick !== w.tick || r.scores[0] !== w.scores[0] || r.scores[1] !== w.scores[1])) {
    return { ok: false, error: `final result mismatch (recorded ${JSON.stringify(w)}, replayed ${JSON.stringify(r)})`, state: eng.state };
  }
  return { ok: true, state: eng.state };
}

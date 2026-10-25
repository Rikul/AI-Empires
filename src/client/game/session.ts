// GameSession: owns the live match (or replay), pacing, pause/speed, history review and autosave.
import { LiveMatch } from '../../shared/controller';
import { MatchEngine } from '../../shared/engine';
import { cloneState, deserializeState, serializeState, SerializedState } from '../../shared/serialize';
import { TICK_RATE } from '../../shared/rules';
import type { Command, DecisionRecord, GameState, MatchRecord, PlayerId } from '../../shared/types';
import { api } from '../api';

export type SessionMode = 'live' | 'replay';

export class GameSession {
  readonly mode: SessionMode;
  engine: MatchEngine; // live engine (or the replay engine)
  live: LiveMatch | null = null;
  review: MatchEngine | null = null;
  paused = true;
  speed: 1 | 2 = 1;
  private acc = 0;
  private lastSave = 0;
  private saving = false;
  private dirty = false;
  stalled = false;
  humanPlayer: PlayerId | null;
  listeners: { decision: ((d: DecisionRecord) => void)[]; tick: (() => void)[]; jump: (() => void)[]; finished: (() => void)[]; request: ((p: PlayerId, t: number) => void)[] } = { decision: [], tick: [], jump: [], finished: [], request: [] };
  seeking: { target: number; progress: number } | null = null;
  saveError: string | null = null;
  lastSavedAt: Date | null = null;
  private finishedNotified = false;

  constructor(public record: MatchRecord, snapshot: SerializedState | null) {
    this.humanPlayer = record.config.players[0].kind === 'human' ? 0 : null;
    if (record.status === 'completed') {
      this.mode = 'replay';
      this.engine = new MatchEngine(record, 'verify');
      this.finishedNotified = true;
    } else {
      this.mode = 'live';
      const start = snapshot && snapshot.tick === record.currentTick ? deserializeState(snapshot) : undefined;
      this.engine = new MatchEngine(record, 'record', start);
      if (!start && record.currentTick > 0) {
        // no usable snapshot: rebuild by re-simulating the log
        while (this.engine.tick < record.currentTick && !this.engine.finished) this.engine.stepOnce();
      }
      this.live = new LiveMatch(this.engine, (p, _ai, messages) => api.chat(record.id, p, messages));
      this.live.onDecision = (d) => { this.dirty = true; this.listeners.decision.forEach((f) => f(d)); };
      this.live.onRequest = (p, t) => this.listeners.request.forEach((f) => f(p, t));
    }
  }

  /** State currently displayed (review position or live). */
  get view(): GameState { return (this.review ?? this.engine).state; }
  get viewEngine(): MatchEngine { return this.review ?? this.engine; }
  get isReviewing() { return !!this.review || this.mode === 'replay'; }
  get liveTick() { return this.mode === 'live' ? this.engine.tick : this.record.currentTick; }
  get endTick() { return this.mode === 'live' ? this.engine.tick : this.record.currentTick; }

  setPaused(p: boolean) {
    if (this.paused === p) return;
    this.paused = p;
    this.acc = 0;
    if (this.mode === 'live' && !this.review) {
      if (this.record.status !== 'completed') this.record.status = p ? 'paused' : 'running';
      this.save(true);
    }
  }

  setSpeed(s: 1 | 2) { this.speed = s; }

  /** Advance by real elapsed seconds. Only whole ticks are simulated (safe tick boundaries). */
  update(dtReal: number) {
    if (this.seeking) return;
    if (this.paused) { this.stalled = this.live?.isStalled() ?? false; return; }
    this.acc += Math.min(dtReal, 0.25) * this.speed * TICK_RATE;
    let steps = 0;
    if (this.review || this.mode === 'replay') {
      const eng = this.viewEngine;
      while (this.acc >= 1 && steps < 20) {
        if (eng.tick >= this.endTick || eng.finished) {
          this.acc = 0;
          if (this.mode === 'replay') this.paused = true;
          break;
        }
        eng.stepOnce();
        this.acc -= 1;
        steps++;
        this.listeners.tick.forEach((f) => f());
      }
      return;
    }
    const live = this.live!;
    this.stalled = false;
    while (this.acc >= 1 && steps < 20) {
      const r = live.tryStep();
      if (r === 'stalled') { this.stalled = true; this.acc = Math.min(this.acc, 1); break; }
      this.acc -= 1;
      steps++;
      this.dirty = true;
      this.listeners.tick.forEach((f) => f());
      if (r === 'finished') {
        this.acc = 0;
        this.paused = true;
        this.save(true);
        if (!this.finishedNotified) { this.finishedNotified = true; this.listeners.finished.forEach((f) => f()); }
        break;
      }
    }
    if (performance.now() - this.lastSave > 15000 && this.dirty) this.save(false);
  }

  /** Alpha for render interpolation between ticks. */
  get alpha() { return this.paused || this.stalled ? 1 : Math.max(0, Math.min(1, this.acc)); }

  issue(cmd: Command) {
    if (this.mode !== 'live' || this.review || this.humanPlayer === null || this.engine.finished) return false;
    this.engine.issue(this.humanPlayer, cmd, 'human');
    this.dirty = true;
    return true;
  }

  // ---- history review ----------------------------------------------------

  enterReview() {
    if (this.mode !== 'live' || this.review) return;
    this.setPaused(true);
    const r = new MatchEngine(this.record, 'none', cloneState(this.engine.state));
    r.snapshots = this.engine.snapshots; // deterministic snapshots are shared with the live engine
    this.review = r;
  }

  exitReview() {
    if (!this.review) return;
    this.review = null;
    this.setPaused(true);
    this.listeners.jump.forEach((f) => f());
  }

  /** Jump to a tick (async, chunked so the UI stays responsive). */
  async seek(tick: number) {
    if (this.mode === 'live' && !this.review) this.enterReview();
    const eng = this.viewEngine;
    const target = Math.max(0, Math.min(tick, this.endTick));
    this.seeking = { target, progress: 0 };
    // pick the starting point
    let best = -1;
    for (const k of eng.snapshots.keys()) if (k <= target && k > best) best = k;
    const from = eng.tick <= target && eng.tick > best ? eng.tick : best;
    if (from !== eng.tick) eng.seek(from, from);
    const start = eng.tick;
    while (eng.tick < target && !eng.finished) {
      const chunkEnd = Math.min(target, eng.tick + 1500);
      while (eng.tick < chunkEnd && !eng.finished) eng.stepOnce();
      this.seeking.progress = (eng.tick - start) / Math.max(1, target - start);
      await new Promise((r) => setTimeout(r, 0));
    }
    this.seeking = null;
    this.acc = 0;
    this.listeners.jump.forEach((f) => f());
  }

  // ---- persistence ---------------------------------------------------------

  async save(_urgent: boolean) {
    if (this.mode !== 'live' || this.saving) return;
    this.saving = true;
    this.lastSave = performance.now();
    this.dirty = false;
    const r = this.record;
    try {
      await api.save(r.id, {
        status: r.status === 'completed' ? 'completed' : this.paused ? 'paused' : 'running',
        currentTick: r.currentTick,
        result: r.result,
        commands: r.commands,
        decisions: r.decisions,
        checksums: r.checksums,
        snapshot: serializeState(this.engine.state),
      });
      this.saveError = null;
      this.lastSavedAt = new Date();
    } catch (e) {
      this.saveError = (e as Error).message;
      this.dirty = true;
    } finally {
      this.saving = false;
    }
  }

  dispose() {
    this.live?.dispose();
  }
}

// LiveMatch: schedules LLM decisions in simulation time and steps the engine.
//
// Decision k for an AI side is requested when the simulation reaches tick k*I (I = decision
// interval) using the state at that tick, and is applied exactly at tick k*I + W (W = response
// window). If the reply has not arrived when the simulation reaches the apply tick, the
// simulation stalls (waits) at that tick boundary. Outcomes therefore never depend on wall-clock
// speed (1x/2x) or model latency — only on the replies, which are recorded for replay.
import { decisionIntervalTicks, decisionWindowTicks, insertCommand, MatchEngine } from './engine';
import { buildMessages, ChatMessage, parseDecision } from './ai/prompt';
import type { AiConnection, DecisionRecord, MatchRecord, PlayerId } from './types';

export interface DecisionReply { content: string; latencyMs: number }
export type DecisionProvider = (player: PlayerId, ai: AiConnection, messages: ChatMessage[]) => Promise<DecisionReply>;

interface Pending { player: PlayerId; requestTick: number; applyTick: number; done: boolean; startedAt: number }

export type StepOutcome = 'stepped' | 'stalled' | 'finished';

export class LiveMatch {
  readonly aiPlayers: PlayerId[];
  pending: Pending[] = [];
  private lastRequested: Record<number, number> = {};
  onDecision?: (d: DecisionRecord) => void;
  onRequest?: (p: PlayerId, tick: number) => void;
  disposed = false;

  constructor(public engine: MatchEngine, public provider: DecisionProvider) {
    const rec = engine.record;
    this.aiPlayers = ([0, 1] as PlayerId[]).filter((p) => rec.config.players[p].kind === 'ai');
    this.recoverInterrupted();
  }

  get record(): MatchRecord { return this.engine.record; }

  /** Decisions that were in flight when the match was saved/closed are recorded as empty. */
  private recoverInterrupted() {
    const rec = this.record;
    const I = decisionIntervalTicks(rec.config), W = decisionWindowTicks(rec.config);
    const X = this.engine.tick;
    for (const p of this.aiPlayers) {
      const done = rec.decisions.filter((d) => d.player === p);
      const maxReq = done.reduce((m, d) => Math.max(m, d.requestTick), -1);
      this.lastRequested[p] = maxReq;
      for (let T = Math.floor(X / I) * I; T >= 0 && T + W > X; T -= I) {
        if (T >= X) continue;
        if (done.some((d) => d.requestTick === T)) continue;
        this.resolve({ player: p, requestTick: T, applyTick: T + W, done: false, startedAt: 0 }, null, 'request interrupted (match was reloaded)', 0);
        this.lastRequested[p] = Math.max(this.lastRequested[p], T);
      }
    }
  }

  isStalled(): boolean {
    const t = this.engine.tick;
    return this.pending.some((p) => !p.done && p.applyTick <= t);
  }

  waitingFor(): Pending[] { return this.pending.filter((p) => !p.done); }

  tryStep(): StepOutcome {
    if (this.engine.finished) return 'finished';
    const t = this.engine.tick;
    const I = decisionIntervalTicks(this.record.config);
    if (t % I === 0) {
      for (const p of this.aiPlayers) {
        if (this.lastRequested[p] === t) continue;
        this.lastRequested[p] = t;
        this.request(p);
      }
    }
    if (this.isStalled()) return 'stalled';
    this.engine.stepOnce();
    this.record.currentTick = this.engine.tick;
    if (this.engine.finished) {
      this.record.status = 'completed';
      this.record.result = this.engine.state.result;
      return 'finished';
    }
    return 'stepped';
  }

  private request(p: PlayerId) {
    const rec = this.record;
    const slot = rec.config.players[p];
    if (slot.kind !== 'ai') return;
    const t = this.engine.tick;
    const pend: Pending = { player: p, requestTick: t, applyTick: t + decisionWindowTicks(rec.config), done: false, startedAt: Date.now() };
    this.pending.push(pend);
    this.onRequest?.(p, t);
    let messages: ChatMessage[];
    try {
      messages = buildMessages(this.engine.state, p);
    } catch (e) {
      this.resolve(pend, null, `failed to build prompt: ${(e as Error).message}`, 0);
      return;
    }
    this.provider(p, slot.ai, messages).then(
      (reply) => this.resolve(pend, reply.content, undefined, reply.latencyMs),
      (err) => this.resolve(pend, null, String((err as Error)?.message ?? err), Date.now() - pend.startedAt),
    );
  }

  private resolve(pend: Pending, content: string | null, error: string | undefined, latencyMs: number) {
    if (this.disposed || pend.done) return;
    pend.done = true;
    this.pending = this.pending.filter((x) => x !== pend);
    const rec = this.record;
    const prevPlan = this.engine.state.players[pend.player].plan;
    const d: DecisionRecord = { player: pend.player, requestTick: pend.requestTick, applyTick: pend.applyTick, latencyMs: Math.max(0, Math.round(latencyMs)), ok: false, commands: [] };
    if (content !== null) {
      d.raw = content.slice(0, 20000);
      try {
        const parsed = parseDecision(content);
        d.ok = true;
        d.thoughts = parsed.thoughts;
        d.plan = parsed.plan;
        d.commands = parsed.commands;
      } catch (e) {
        d.error = `could not parse reply: ${(e as Error).message}`;
      }
    } else d.error = error ?? 'unknown error';
    rec.decisions.push(d);
    // a decision whose apply tick already passed (only possible after a reload) applies now
    const tick = Math.max(pend.applyTick, this.engine.tick);
    insertCommand(rec.commands, { tick, player: pend.player, source: 'ai', cmd: { t: 'ai', plan: d.ok ? d.plan ?? '' : prevPlan, cmds: d.commands } });
    this.onDecision?.(d);
  }

  dispose() { this.disposed = true; }
}

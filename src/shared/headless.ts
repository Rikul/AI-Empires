// Runs matches without a browser (tests, tooling). Uses the scripted mock commander.
import { LiveMatch, DecisionProvider } from './controller';
import { MatchEngine, newRecord } from './engine';
import { extractObservation, mockDecide } from './ai/mock';
import { DEFAULT_POP_CAP } from './rules';
import type { MatchConfig, MatchRecord, PlayerSlot } from './types';

export const mockProvider: DecisionProvider = async (_p, ai, messages) => {
  const obs = extractObservation(messages[messages.length - 1].content);
  if (!obs) throw new Error('no observation');
  return { content: JSON.stringify(mockDecide(obs, ai.name)), latencyMs: 0 };
};

export function testConfig(over: Partial<MatchConfig> = {}): MatchConfig {
  const ai = (name: string): PlayerSlot => ({ kind: 'ai', ai: { name, baseUrl: 'http://localhost/mock/v1', model: 'mock' } });
  return {
    mode: 'ava', mapSize: 'Small', biome: 'TemperateGrasslands', seed: 'test', popCap: DEFAULT_POP_CAP, timeLimitMin: 60,
    generationVersion: 1, rulesVersion: 1, decisionIntervalSec: 15, decisionWindowSec: 5,
    players: [ai('Alpha'), ai('Bravo')],
    ...over,
  };
}

export async function runHeadless(config: MatchConfig, opts: { maxTicks?: number; provider?: DecisionProvider; onTick?: (m: LiveMatch) => void } = {}): Promise<{ record: MatchRecord; live: LiveMatch }> {
  const record = newRecord(config, 'headless', 'headless');
  const engine = new MatchEngine(record, 'record');
  const live = new LiveMatch(engine, opts.provider ?? mockProvider);
  const max = opts.maxTicks ?? Infinity;
  while (engine.tick < max) {
    const r = live.tryStep();
    if (r === 'finished') break;
    if (r === 'stalled') { await new Promise((res) => setTimeout(res, 0)); continue; }
    opts.onTick?.(live);
  }
  if (record.status !== 'completed') record.status = 'paused';
  return { record, live };
}

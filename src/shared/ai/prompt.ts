// Prompt construction and response parsing for OpenAI-compatible chat models.
import {
  BUILDING_TYPES, BUILDINGS, costString, TECH_TYPES, TECHS, UNIT_TYPES, UNITS,
} from '../rules';
import type { AiCommand, GameState, PlayerId } from '../types';
import { buildObservation, Observation } from './observation';

export const OBS_BEGIN = '<<<OBSERVATION_JSON';
export const OBS_END = 'OBSERVATION_JSON>>>';

export function systemPrompt(decisionIntervalSec: number, windowSec: number): string {
  const units = UNIT_TYPES.map((t) => {
    const u = UNITS[t];
    const bonus = u.bonus ? ` bonus ${Object.entries(u.bonus).map(([k, v]) => `+${v} vs ${k}`).join(',')}` : '';
    const req = u.requires.length ? ` requires ${u.requires.join('+')}` : '';
    return `- ${t}: ${costString(u.cost)}; from ${u.trainedAt}${req}; hp ${u.hp}, atk ${u.attack} ${u.attackKind}, armor ${u.meleeArmor}/${u.pierceArmor}, range ${u.range}, speed ${u.speed}${bonus}. ${u.description}`;
  }).join('\n');
  const blds = BUILDING_TYPES.map((t) => {
    const b = BUILDINGS[t];
    const req = b.requires.length ? ` requires ${b.requires.join('+')};` : '';
    return `- ${t} (${b.size}x${b.size}): ${costString(b.cost)};${req} hp ${b.hp}. ${b.description}`;
  }).join('\n');
  const techs = TECH_TYPES.map((t) => `- ${t}: ${costString(TECHS[t].cost)}. ${TECHS[t].description}`).join('\n');
  return `You are the autonomous commander of one side in "AI Empires", a real-time strategy game similar to classic Age of Empires. You make ALL strategic decisions for your side: exploration, gathering assignments, building placement, unit production, movement, attack targets, defense, and army coordination.

GOAL: Win by conquest — destroy the enemy Town Center AND every enemy unit (other enemy buildings do not matter). If the time limit is reached, the side with the higher surviving asset value wins (sum of the original resource cost of every surviving unit and building times its remaining HP fraction).

TIMING: You are consulted every ${decisionIntervalSec} seconds of game time. Your commands take effect ${windowSec} seconds of game time after the observation was taken. Between decisions units keep doing their last task (villagers keep gathering, idle soldiers fight enemies that come near).

MAP: square tile grid, x grows to the east (right), y grows to the south (down). Coordinates are tile units [x, y]. Trees, gold, stone, berry bushes, water and rocks block movement. You only see what your units and buildings currently see; explored areas remember terrain and resources.

ECONOMY: Villagers carry up to 10 resources and must walk to a compatible drop-off building: Town Center (all), Granary (food), Storage Pit (wood, gold, stone). Build drop-offs next to remote resources. Natural resources are finite. Food sources: berry bushes, hunting deer (villagers kill then gather the carcass), Farms (need a Granary; 300 food each). Houses add 5 population, Town Center 10. Population cap per side: see observation.

UNITS:
${units}

BUILDINGS:
${blds}

BLACKSMITH TECHNOLOGIES:
${techs}

COUNTERS: Spearmen beat cavalry. Cavalry beats archers. Skirmishers beat archers. Archers beat slow infantry. Centurions and Swordsmen are strong all-round melee. Watch Towers defend areas. Damage = max(1, attack - armor) + bonus.

RESPONSE FORMAT: reply with ONLY one JSON object (no markdown):
{"thoughts": "<brief analysis>", "plan": "<short plan you want to remember next turn>", "commands": [ ... ]}

COMMANDS (each is a JSON object; "units" may be a list of unit ids or a selector string):
Unit selectors: "idle_villagers", "villagers", "military", "idle_military", "scouts", "all", "type:<UnitType>", "gatherers:<food|wood|gold|stone>", "group:<name>". Add "count": N to take N units (idle and nearest first).
- {"type":"gather","units":<sel>,"count":N,"resource":"food|wood|gold|stone|berries|hunt|farm","near":[x,y]}   assign villagers to gather (nearest known resource to "near")
- {"type":"build","building":"<BuildingType>","at":[x,y],"units":<sel>,"count":N}   place a building centred near [x,y] (auto-adjusted to the nearest valid spot); villagers build it
- {"type":"build","building":"Wall","at":[x1,y1],"to":[x2,y2],"count":N}   wall line
- {"type":"train","unit":"<UnitType>","count":N}   queue units at a suitable finished building (cost paid when queued)
- {"type":"research","tech":"<Tech>"}
- {"type":"explore","units":<sel>}   automatic exploration of unexplored land; or add "to":[x,y] to scout a location
- {"type":"move","units":<sel>,"to":[x,y]}
- {"type":"attack","units":<sel>,"target":<enemy id>}   attack a visible/known enemy unit or building; or "to":[x,y] for attack-move (fight everything on the way)
- {"type":"defend","units":<sel>,"at":[x,y],"radius":R}   hold an area and engage enemies inside it
- {"type":"group","name":"<name>","units":<sel>}   create/replace a named army group; then command it with "units":"group:<name>"
- {"type":"stop","units":<sel>}
- {"type":"rally","building":<id or type>,"at":[x,y]}   where newly trained units gather

GUIDELINES: Keep villager production going early (Town Center trains one Villager at a time — queue a few). Avoid being population capped: build a House before you run out of room. Use idle villagers. Scout early to find resources and the enemy. Build an army, coordinate it in groups, defend your villagers when attacked, and attack the enemy Town Center with a strong force. Only reference ids that appear in the observation. Issue at most 25 commands per turn; omit commands that would repeat what units are already doing.`;
}

export function userPrompt(obs: Observation): string {
  return `Current observation of your side (fog of war applies):\n${OBS_BEGIN}\n${JSON.stringify(obs)}\n${OBS_END}\nRespond with the JSON object now.`;
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export function buildMessages(s: GameState, p: PlayerId): ChatMessage[] {
  const obs = buildObservation(s, p);
  return [
    { role: 'system', content: systemPrompt(s.config.decisionIntervalSec, s.config.decisionWindowSec) },
    { role: 'user', content: userPrompt(obs) },
  ];
}

export interface ParsedDecision {
  thoughts: string;
  plan: string;
  commands: AiCommand[];
}

const VALID_TYPES = new Set(['gather', 'build', 'train', 'research', 'explore', 'move', 'attack', 'defend', 'group', 'stop', 'rally']);
const TYPE_ALIASES: Record<string, string> = {
  attackmove: 'attack', attack_move: 'attack', assault: 'attack', raid: 'attack',
  scout: 'explore', exploration: 'explore',
  guard: 'defend', hold: 'defend', protect: 'defend', defense: 'defend',
  produce: 'train', recruit: 'train', queue: 'train', create: 'train',
  construct: 'build', place: 'build', build_wall: 'build',
  collect: 'gather', harvest: 'gather', assign: 'gather', gathering: 'gather',
  retreat: 'move', go: 'move', relocate: 'move',
  set_group: 'group', create_group: 'group', army: 'group',
  set_rally: 'rally', rally_point: 'rally', halt: 'stop',
};

/** Make common near-JSON output parseable: comments and trailing commas. */
function relaxJson(t: string): string {
  return t.replace(/\/\/[^\n"]*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,\s*([}\]])/g, '$1');
}

function tryParse(t: string): unknown {
  try { return JSON.parse(t); } catch { return JSON.parse(relaxJson(t)); }
}

/** Extract the decision JSON from a model reply (tolerates markdown fences and surrounding prose). */
export function parseDecision(text: string): ParsedDecision {
  let t = text.trim();
  // strip reasoning blocks some models emit
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  let obj: unknown;
  try {
    obj = tryParse(t);
  } catch {
    const start = t.indexOf('{');
    if (start < 0) throw new Error('no JSON object in reply');
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) throw new Error('unterminated JSON object in reply');
    obj = tryParse(t.slice(start, end + 1));
  }
  if (Array.isArray(obj)) obj = { commands: obj };
  if (!obj || typeof obj !== 'object') throw new Error('reply is not a JSON object');
  const o = obj as Record<string, unknown>;
  const rawCmds = Array.isArray(o.commands) ? o.commands : Array.isArray(o.actions) ? o.actions : [];
  const commands: AiCommand[] = [];
  for (const c of rawCmds) {
    if (!c || typeof c !== 'object') continue;
    const cc = { ...(c as Record<string, unknown>) };
    if (typeof cc.type !== 'string' && typeof cc.action === 'string') cc.type = cc.action;
    if (typeof cc.type !== 'string') continue;
    let ty = (cc.type as string).toLowerCase().trim().replace(/[\s-]+/g, '_');
    ty = TYPE_ALIASES[ty] ?? TYPE_ALIASES[ty.replace(/_/g, '')] ?? ty;
    if (!VALID_TYPES.has(ty)) continue;
    cc.type = ty;
    commands.push(sanitize(cc) as AiCommand);
  }
  return {
    thoughts: String(o.thoughts ?? o.reasoning ?? '').slice(0, 2000),
    plan: String(o.plan ?? '').slice(0, 800),
    commands: commands.slice(0, 40),
  };
}

/** Keep only JSON-safe plain values of bounded size. */
function sanitize(v: unknown, depth = 0): unknown {
  if (depth > 3) return null;
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, 200);
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => sanitize(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 20)) out[k.slice(0, 40)] = sanitize(x, depth + 1);
    return out;
  }
  return null;
}

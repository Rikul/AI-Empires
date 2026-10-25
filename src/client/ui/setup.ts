import { api } from '../api';
import { navigate } from '../main';
import { generateMap, mapStats } from '../../shared/mapgen';
import {
  Biome, BIOME_NAMES, BIOMES, DEFAULT_POP_CAP, DEFAULT_TIME_LIMIT_MIN, GENERATION_VERSION, MAP_SIZES, MapSize, RULES_VERSION, Terrain,
} from '../../shared/rules';
import type { AiConnection, MatchConfig, MatchMode, PlayerSlot } from '../../shared/types';
import { renderMapImage } from '../render/minimap';
import { terrainHex } from '../render/palette';
import { h, toast } from './dom';

const LS_KEY = 'ai-empires-setup-v1';

interface SetupState {
  mode: MatchMode;
  mapSize: MapSize;
  biome: Biome;
  seed: string;
  popCap: number;
  timeLimitMin: number;
  decisionIntervalSec: number;
  decisionWindowSec: number;
  humanName: string;
  ais: [AiConnection, AiConnection];
}

function mockConn(name: string): AiConnection {
  return { name, baseUrl: `${location.origin}/mock/v1`, model: 'scripted-mock', apiKey: '' };
}

function randomSeed() { return Math.random().toString(36).slice(2, 8); }

function load(): SetupState {
  const def: SetupState = {
    mode: 'pva', mapSize: 'Medium', biome: 'TemperateGrasslands', seed: randomSeed(), popCap: DEFAULT_POP_CAP, timeLimitMin: DEFAULT_TIME_LIMIT_MIN,
    decisionIntervalSec: 15, decisionWindowSec: 10, humanName: 'Player',
    ais: [{ name: 'Commander Blue', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' }, { name: 'Commander Red', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' }],
  };
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
    if (s) return { ...def, ...s, seed: randomSeed(), ais: [{ ...def.ais[0], ...s.ais?.[0], apiKey: '' }, { ...def.ais[1], ...s.ais?.[1], apiKey: '' }] };
  } catch { /* ignore */ }
  return def;
}

function persist(s: SetupState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...s, ais: s.ais.map((a) => ({ ...a, apiKey: undefined })) }));
  } catch { /* ignore */ }
}

export function renderSetup(root: HTMLElement): () => void {
  const st = load();
  let previewTimer = 0;

  const field = (label: string, input: HTMLElement) => h('div', {}, h('label', {}, label), input);
  const select = <T extends string>(value: T, opts: [T, string][], on: (v: T) => void) => {
    const s = h('select', { onchange: () => { on(s.value as T); refreshPreview(); } }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l))) as HTMLSelectElement;
    return s;
  };
  const num = (value: number, min: number, max: number, step: number, on: (v: number) => void) => {
    const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step) }) as HTMLInputElement;
    i.addEventListener('input', () => { const v = Number(i.value); if (Number.isFinite(v)) on(v); });
    return i;
  };

  const modeSeg = h('div', { class: 'seg' });
  const playersBox = h('div', { style: { display: 'grid', gap: '12px' } });
  const previewBox = h('div', { class: 'card preview' });
  const seedInput = h('input', { value: st.seed, style: { width: '100%' } }) as HTMLInputElement;
  seedInput.addEventListener('input', () => { st.seed = seedInput.value.trim(); refreshPreview(); });

  function renderMode() {
    modeSeg.replaceChildren(
      h('button', { class: st.mode === 'pva' ? 'active' : '', onclick: () => { st.mode = 'pva'; renderMode(); renderPlayers(); refreshPreview(); } }, '🧑 Player vs AI'),
      h('button', { class: st.mode === 'ava' ? 'active' : '', onclick: () => { st.mode = 'ava'; renderMode(); renderPlayers(); refreshPreview(); } }, '🤖 AI vs AI'),
    );
  }

  function aiCard(idx: 0 | 1, title: string, color: string) {
    const ai = st.ais[idx];
    const result = h('div', { class: 'test-result' });
    const inp = (key: keyof AiConnection, placeholder: string, type = 'text') => {
      const i = h('input', { type, value: ai[key] ?? '', placeholder, autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
      i.addEventListener('input', () => { (ai as unknown as Record<string, string>)[key] = i.value; });
      return i;
    };
    const fields = {
      name: inp('name', 'Display name'),
      baseUrl: inp('baseUrl', 'https://api.openai.com/v1'),
      model: inp('model', 'model id, e.g. gpt-4o-mini'),
      apiKey: inp('apiKey', 'optional', 'password'),
    };
    const test = async () => {
      result.className = 'test-result';
      result.textContent = 'Testing…';
      try {
        const r = await api.test({ ...ai });
        if (r.ok) { result.className = 'test-result ok'; result.textContent = `✓ Connected (${r.latencyMs} ms): ${r.content?.slice(0, 80)}`; }
        else { result.className = 'test-result err'; result.textContent = `✗ ${r.error}`; }
      } catch (e) { result.className = 'test-result err'; result.textContent = `✗ ${(e as Error).message}`; }
    };
    const useMock = () => {
      const m = mockConn(ai.name || title);
      Object.assign(ai, m);
      fields.baseUrl.value = m.baseUrl; fields.model.value = m.model; fields.apiKey.value = '';
      result.className = 'test-result ok';
      result.textContent = 'Using the built-in scripted test commander (no LLM). Replace with a real endpoint for LLM play.';
    };
    return h('div', { class: 'ai-card' },
      h('h3', {}, h('span', { class: 'dot', style: { background: color } }), title),
      h('div', { class: 'grid' },
        field('Display name', fields.name),
        field('Model identifier', fields.model),
        h('div', { style: { gridColumn: '1 / -1' } }, field('OpenAI-compatible base URL', fields.baseUrl)),
        h('div', { style: { gridColumn: '1 / -1' } }, field('API key (optional, stored only on this server)', fields.apiKey)),
      ),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { onclick: test }, 'Test connection'),
        h('button', { onclick: useMock, title: 'Fill in the built-in scripted commander (for trying the game without an LLM)' }, 'Use test commander'),
      ),
      result,
    );
  }

  function renderPlayers() {
    if (st.mode === 'pva') {
      const name = h('input', { value: st.humanName, style: { width: '100%' } }) as HTMLInputElement;
      name.addEventListener('input', () => { st.humanName = name.value; });
      playersBox.replaceChildren(
        h('div', { class: 'ai-card' }, h('h3', {}, h('span', { class: 'dot', style: { background: 'var(--blue)' } }), 'You (Blue)'), field('Your name', name)),
        aiCard(1, 'AI opponent (Red)', 'var(--red)'),
      );
    } else {
      playersBox.replaceChildren(aiCard(0, 'Left AI (Blue)', 'var(--blue)'), aiCard(1, 'Right AI (Red)', 'var(--red)'));
    }
  }

  function refreshPreview() {
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(drawPreview, 120);
  }

  function drawPreview() {
    const canvas = h('canvas', { width: 320, height: 320 }) as HTMLCanvasElement;
    const g = canvas.getContext('2d')!;
    const swatches = h('div', { class: 'swatches' }, ...([
      [Terrain.Grass, 'Grass'], [Terrain.Dirt, 'Dirt'], [Terrain.Sand, 'Sand'], [Terrain.Snow, 'Snow'], [Terrain.Forest, 'Forest'], [Terrain.Rock, 'Rock'], [Terrain.Water, 'Water'],
    ] as [Terrain, string][]).map(([t, l]) => h('span', { class: 'swatch' }, h('i', { style: { background: `#${terrainHex(st.biome, t).toString(16).padStart(6, '0')}` } }), l)));
    if (st.mode === 'ava') {
      const m = generateMap(st.seed || 'seed', st.mapSize, st.biome);
      g.putImageData(renderMapImage(m, st.biome, 320), 0, 0);
      const k = 320 / m.size;
      m.starts.forEach(([x, y], i) => {
        g.fillStyle = i === 0 ? '#3d7bff' : '#ff4a3d';
        g.strokeStyle = '#000';
        g.lineWidth = 2;
        g.beginPath(); g.arc((x + 0.5) * k, (y + 0.5) * k, 7, 0, Math.PI * 2); g.fill(); g.stroke();
      });
      const stats = mapStats(m);
      previewBox.replaceChildren(
        h('h3', { style: { marginBottom: '8px' } }, 'Generated map preview'),
        canvas,
        h('div', { class: 'small muted', style: { marginTop: '8px' } },
          `${st.mapSize} ${m.size}×${m.size} · ${BIOME_NAMES[st.biome]} · seed "${st.seed}" · generation v${GENERATION_VERSION}`, h('br'),
          `Trees ${stats.trees} · gold tiles ${stats.gold} · stone tiles ${stats.stone} · berry bushes ${stats.berries} · ${Math.round(stats.reachableFraction * 100)}% walkable`),
        swatches,
      );
    } else {
      // Style sample from a fixed, unrelated seed: shows the biome look without revealing this map.
      const sample = generateMap('style-sample', 'Small', st.biome);
      const full = renderMapImage(sample, st.biome, 96 * 4);
      const tmp = h('canvas', { width: full.width, height: full.height }) as HTMLCanvasElement;
      tmp.getContext('2d')!.putImageData(full, 0, 0);
      g.imageSmoothingEnabled = true;
      g.filter = 'blur(1px)';
      g.drawImage(tmp, 140, 140, 140, 140, 0, 0, 320, 320);
      g.filter = 'none';
      g.fillStyle = '#0008';
      g.fillRect(0, 286, 320, 34);
      g.fillStyle = '#fff';
      g.font = '13px system-ui';
      g.fillText('Biome style sample — not your map', 10, 308);
      previewBox.replaceChildren(
        h('h3', { style: { marginBottom: '8px' } }, `${BIOME_NAMES[st.biome]} — terrain style`),
        canvas,
        h('div', { class: 'small muted', style: { marginTop: '8px' } }, `The actual ${st.mapSize} (${MAP_SIZES[st.mapSize]}×${MAP_SIZES[st.mapSize]}) map stays hidden until you explore it. Its layout and resources are not shown here.`),
        swatches,
      );
    }
  }

  async function start(btn: HTMLButtonElement) {
    const slot = (a: AiConnection): PlayerSlot => ({ kind: 'ai', ai: { name: a.name.trim() || 'AI', baseUrl: a.baseUrl.trim(), model: a.model.trim(), ...(a.apiKey?.trim() ? { apiKey: a.apiKey.trim() } : {}) } });
    const players: [PlayerSlot, PlayerSlot] = st.mode === 'pva'
      ? [{ kind: 'human', name: st.humanName.trim() || 'Player' }, slot(st.ais[1])]
      : [slot(st.ais[0]), slot(st.ais[1])];
    for (const p of players) {
      if (p.kind === 'ai' && (!/^https?:\/\//.test(p.ai.baseUrl) || !p.ai.model)) { toast('Each AI needs an http(s) base URL and a model identifier', 'error'); return; }
    }
    const config: MatchConfig = {
      mode: st.mode, mapSize: st.mapSize, biome: st.biome, seed: st.seed || randomSeed(),
      popCap: Math.round(st.popCap), timeLimitMin: Math.round(st.timeLimitMin),
      generationVersion: GENERATION_VERSION, rulesVersion: RULES_VERSION,
      decisionIntervalSec: st.decisionIntervalSec, decisionWindowSec: Math.min(st.decisionWindowSec, st.decisionIntervalSec),
      players,
    };
    persist(st);
    btn.disabled = true;
    try {
      const rec = await api.create(config);
      navigate({ name: 'game', id: rec.id }, true);
    } catch (e) {
      const errs = (e as Error & { errors?: string[] }).errors;
      toast(errs?.length ? errs.join('; ') : (e as Error).message, 'error');
      btn.disabled = false;
    }
  }

  const startBtn = h('button', { class: 'primary', style: { padding: '10px 26px', fontSize: '16px' } }, 'Start match') as HTMLButtonElement;
  startBtn.addEventListener('click', () => start(startBtn));

  renderMode();
  renderPlayers();
  const screen = h('div', { class: 'screen' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, '⚔️'), h('div', {}, h('h1', {}, 'New match'), h('div', { class: 'muted small' }, 'Both sides use identical rules, starting resources, units and buildings.'))),
    h('div', { class: 'setup' },
      h('div', { style: { display: 'grid', gap: '14px' } },
        h('div', { class: 'card' }, h('label', {}, 'Mode'), modeSeg),
        h('div', { class: 'card' },
          h('div', { class: 'field-grid' },
            field('Map size', select(st.mapSize, (Object.keys(MAP_SIZES) as MapSize[]).map((k) => [k, `${k} (${MAP_SIZES[k]}×${MAP_SIZES[k]})`]), (v) => { st.mapSize = v; })),
            field('Biome', select(st.biome, BIOMES.map((b) => [b, BIOME_NAMES[b]]), (v) => { st.biome = v; })),
            field('Seed', h('div', { class: 'row', style: { flexWrap: 'nowrap', gap: '4px' } }, seedInput, h('button', { title: 'Random seed', onclick: () => { st.seed = randomSeed(); seedInput.value = st.seed; refreshPreview(); } }, '🎲'))),
            field('Population cap / side', num(st.popCap, 10, 500, 5, (v) => { st.popCap = v; })),
            field('Time limit (sim minutes)', num(st.timeLimitMin, 1, 240, 1, (v) => { st.timeLimitMin = v; })),
          ),
          h('details', { style: { marginTop: '12px' } },
            h('summary', {}, 'AI decision timing'),
            h('div', { class: 'field-grid', style: { marginTop: '8px' } },
              field('Decision interval (sim s)', num(st.decisionIntervalSec, 2, 120, 1, (v) => { st.decisionIntervalSec = v; })),
              field('Response window (sim s)', num(st.decisionWindowSec, 1, 120, 1, (v) => { st.decisionWindowSec = v; })),
            ),
            h('p', { class: 'small muted' }, 'Decisions are requested every interval of simulated time and applied exactly one response window later. If a model is slower, the simulation waits — so outcomes do not depend on game speed or model latency.'),
          ),
        ),
        playersBox,
        h('div', { class: 'row' }, h('button', { onclick: () => navigate({ name: 'home' }) }, '← Back'), h('div', { class: 'grow' }), startBtn),
      ),
      previewBox,
    ),
  );
  root.appendChild(screen);
  drawPreview();
  return () => clearTimeout(previewTimer);
}

import { api, download, MatchSummary } from '../api';
import { navigate } from '../main';
import { BIOME_NAMES, TICK_RATE } from '../../shared/rules';
import { fmtTime } from '../../shared/ai/observation';
import { h, modal, toast } from './dom';

export function renderHome(root: HTMLElement): () => void {
  const list = h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Loading saved matches…'));
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } }) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    const text = await f.text();
    const busy = modal(h('div', {}, h('h2', {}, 'Importing…'), h('p', { class: 'muted' }, `Validating ${f.name} and verifying the full replay. Long matches can take a few seconds.`)));
    try {
      const r = await api.import(text);
      busy();
      toast(`Imported and verified (${fmtTime(r.verifiedTicks)} of play in ${(r.ms / 1000).toFixed(1)}s)`);
      refresh();
    } catch (e) {
      busy();
      const errs = (e as Error & { errors?: string[] }).errors ?? [(e as Error).message];
      modal(h('div', {}, h('h2', {}, 'Import rejected'), h('p', { class: 'muted' }, `${f.name} failed validation:`), h('ul', {}, ...errs.slice(0, 30).map((x) => h('li', {}, x)))));
    }
  });

  const screen = h('div', { class: 'screen' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, '🏛️'), h('div', {}, h('h1', {}, 'AI Empires'), h('div', { class: 'muted small' }, 'Ancient-era real-time strategy — command an empire against an LLM, or watch two LLM commanders battle.'))),
    h('div', { class: 'row', style: { marginBottom: '16px' } },
      h('button', { class: 'primary', onclick: () => navigate({ name: 'setup' }) }, '⚔️  New match'),
      h('button', { onclick: () => fileInput.click() }, '📂  Import match file'),
      fileInput,
    ),
    h('h2', { style: { fontSize: '17px', margin: '6px 0 10px' } }, 'Saved matches'),
    list,
  );
  root.appendChild(screen);

  async function refresh() {
    let matches: MatchSummary[];
    try { matches = await api.list(); } catch (e) { list.replaceChildren(h('div', { class: 'empty' }, `Could not reach the server: ${(e as Error).message}`)); return; }
    if (!matches.length) { list.replaceChildren(h('div', { class: 'empty' }, 'No saved matches yet. Start a new match!')); return; }
    const rows = matches.map((m) => {
      const players = m.config.players.map((p, i) => h('span', { style: { color: i === 0 ? 'var(--blue)' : 'var(--red)' } }, p.kind === 'human' ? `${p.name || 'You'} (human)` : `${p.ai.name || 'AI'} · ${p.ai.model}`));
      const result = m.result ? (m.result.winner === null ? 'Draw' : `${m.config.players[m.result.winner].kind === 'human' ? (m.config.players[m.result.winner] as { name: string }).name || 'Human' : (m.config.players[m.result.winner] as { ai: { name: string } }).ai.name} wins (${m.result.reason})`) : '';
      return h('tr', {},
        h('td', {}, h('div', {}, h('b', {}, m.name)), h('div', { class: 'small' }, players[0], ' vs ', players[1])),
        h('td', {}, m.mode === 'pva' ? 'Player vs AI' : 'AI vs AI'),
        h('td', {}, `${m.config.mapSize} · ${BIOME_NAMES[m.config.biome]}`, h('div', { class: 'small muted' }, `seed ${m.config.seed}`)),
        h('td', {}, h('span', { class: `badge ${m.status}` }, m.status), h('div', { class: 'small muted' }, `${fmtTime(m.currentTick)} / ${m.config.timeLimitMin}:00`)),
        h('td', { class: 'small' }, result),
        h('td', { class: 'small muted' }, new Date(m.updatedAt).toLocaleString()),
        h('td', {}, h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
          h('button', { class: 'primary', onclick: () => navigate({ name: 'game', id: m.id }) }, m.status === 'completed' ? '▶ Replay' : '▶ Resume'),
          h('button', { title: 'Export versioned match JSON', onclick: () => download(api.exportUrl(m.id)) }, 'Export'),
          h('button', { class: 'danger', title: 'Delete', onclick: async () => { if (!confirm(`Delete "${m.name}"?`)) return; await api.remove(m.id); refresh(); } }, '🗑'),
        )),
      );
    });
    list.replaceChildren(h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'matches' },
      h('thead', {}, h('tr', {}, ...['Match', 'Mode', 'Map', 'Status', 'Result', 'Updated', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...rows))));
  }
  refresh();
  void TICK_RATE;
  return () => {};
}

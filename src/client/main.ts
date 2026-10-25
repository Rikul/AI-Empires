import { renderHome } from './ui/home';
import { renderSetup } from './ui/setup';
import { openGame } from './ui/game';

const app = document.getElementById('app')!;
let cleanup: (() => void) | null = null;

export type Route = { name: 'home' } | { name: 'setup' } | { name: 'game'; id: string };

export function navigate(r: Route, replace = false) {
  const hash = r.name === 'home' ? '#/' : r.name === 'setup' ? '#/new' : `#/match/${r.id}`;
  if (replace) history.replaceState(null, '', hash); else history.pushState(null, '', hash);
  show(r);
}

function parse(): Route {
  const h = location.hash;
  const m = h.match(/^#\/match\/([\w-]+)/);
  if (m) return { name: 'game', id: m[1] };
  if (h.startsWith('#/new')) return { name: 'setup' };
  return { name: 'home' };
}

async function show(r: Route) {
  cleanup?.();
  cleanup = null;
  app.innerHTML = '';
  if (r.name === 'home') cleanup = renderHome(app);
  else if (r.name === 'setup') cleanup = renderSetup(app);
  else cleanup = await openGame(app, r.id);
}

window.addEventListener('popstate', () => show(parse()));
show(parse());

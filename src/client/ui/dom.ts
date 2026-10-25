// Tiny DOM helpers.
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function toast(text: string, kind: 'info' | 'error' = 'info') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = h('div', { class: `toast ${kind}` }, text);
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild?.remove();
  setTimeout(() => t.remove(), 3300);
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

let tip: HTMLDivElement | null = null;
/** Attach a hover tooltip. */
export function tooltip(el: HTMLElement, text: () => string) {
  el.addEventListener('mouseenter', () => {
    tip?.remove();
    tip = h('div', { class: 'tooltip', html: text() });
    document.body.appendChild(tip);
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(window.innerWidth - tr.width - 4, r.left + r.width / 2 - tr.width / 2))}px`;
    tip.style.top = `${r.top - tr.height - 6 < 0 ? r.bottom + 6 : r.top - tr.height - 6}px`;
  });
  el.addEventListener('mouseleave', () => { tip?.remove(); tip = null; });
}
export function clearTooltip() { tip?.remove(); tip = null; }

export function modal(content: Node, onClose?: () => void): () => void {
  const ov = h('div', { class: 'overlay' }, h('div', { class: 'modal' }, content));
  const close = () => { ov.remove(); onClose?.(); };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  document.body.appendChild(ov);
  return close;
}

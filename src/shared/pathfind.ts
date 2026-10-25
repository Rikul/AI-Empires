// Weighted A* on the tile grid (8-directional, no corner cutting). Deterministic.

const SQRT2 = Math.SQRT2;
let cap = 0;
let gScore: Float64Array;
let parent: Int32Array;
let stamp: Uint32Array;
let closed: Uint32Array;
let heapIdx: Int32Array;
let heapF: Float64Array;
let heapSize = 0;
let gen = 0;

function ensure(n: number) {
  if (n <= cap) return;
  cap = n;
  gScore = new Float64Array(n);
  parent = new Int32Array(n);
  stamp = new Uint32Array(n);
  closed = new Uint32Array(n);
  heapIdx = new Int32Array(n * 8 + 16);
  heapF = new Float64Array(n * 8 + 16);
}

function heapPush(i: number, f: number) {
  let k = heapSize++;
  while (k > 0) {
    const p = (k - 1) >> 1;
    if (heapF[p] <= f) break;
    heapIdx[k] = heapIdx[p];
    heapF[k] = heapF[p];
    k = p;
  }
  heapIdx[k] = i;
  heapF[k] = f;
}

function heapPop(): number {
  const top = heapIdx[0];
  const lastI = heapIdx[--heapSize];
  const lastF = heapF[heapSize];
  let k = 0;
  for (;;) {
    let c = 2 * k + 1;
    if (c >= heapSize) break;
    if (c + 1 < heapSize && heapF[c + 1] < heapF[c]) c++;
    if (heapF[c] >= lastF) break;
    heapIdx[k] = heapIdx[c];
    heapF[k] = heapF[c];
    k = c;
  }
  heapIdx[k] = lastI;
  heapF[k] = lastF;
  return top;
}

export interface PathQuery {
  size: number;
  blocked: (i: number) => boolean;
  sx: number; // start tile
  sy: number;
  /** goal rectangle (inclusive tile bounds) */
  gx0: number;
  gy0: number;
  gx1: number;
  gy1: number;
  /** goal = passable tile within this Chebyshev distance of the rect */
  reach: number;
  maxNodes: number;
}

export interface PathResult {
  path: number[]; // tile indices excluding start
  complete: boolean;
  expanded: number;
}

export function findPath(q: PathQuery): PathResult {
  const S = q.size;
  ensure(S * S);
  gen++;
  if (gen === 0xffffffff) { stamp.fill(0); closed.fill(0); gen = 1; }
  heapSize = 0;
  const start = q.sy * S + q.sx;
  const hOf = (x: number, y: number) => {
    const dx = x < q.gx0 ? q.gx0 - x : x > q.gx1 ? x - q.gx1 : 0;
    const dy = y < q.gy0 ? q.gy0 - y : y > q.gy1 ? y - q.gy1 : 0;
    const mn = dx < dy ? dx : dy, mx = dx < dy ? dy : dx;
    return (mx - mn + mn * SQRT2) * 1.25;
  };
  const isGoal = (x: number, y: number) => {
    const dx = x < q.gx0 ? q.gx0 - x : x > q.gx1 ? x - q.gx1 : 0;
    const dy = y < q.gy0 ? q.gy0 - y : y > q.gy1 ? y - q.gy1 : 0;
    return (dx > dy ? dx : dy) <= q.reach;
  };
  stamp[start] = gen;
  gScore[start] = 0;
  parent[start] = -1;
  heapPush(start, hOf(q.sx, q.sy));
  let best = start;
  let bestH = hOf(q.sx, q.sy);
  let expanded = 0;
  let found = -1;
  while (heapSize > 0) {
    const cur = heapPop();
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    const cx = cur % S, cy = (cur / S) | 0;
    if (isGoal(cx, cy) && (cur === start || !q.blocked(cur))) { found = cur; break; }
    const h = hOf(cx, cy);
    if (h < bestH) { bestH = h; best = cur; }
    if (++expanded > q.maxNodes) break;
    const g = gScore[cur];
    for (let d = 0; d < 8; d++) {
      const dx = DX[d], dy = DY[d];
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
      const ni = ny * S + nx;
      if (closed[ni] === gen) continue;
      if (q.blocked(ni)) continue;
      if (dx !== 0 && dy !== 0) {
        if (q.blocked(cy * S + nx) || q.blocked(ny * S + cx)) continue;
      }
      const ng = g + (dx !== 0 && dy !== 0 ? SQRT2 : 1);
      if (stamp[ni] === gen && gScore[ni] <= ng) continue;
      stamp[ni] = gen;
      gScore[ni] = ng;
      parent[ni] = cur;
      heapPush(ni, ng + hOf(nx, ny));
    }
  }
  const end = found >= 0 ? found : best;
  const path: number[] = [];
  let c = end;
  while (c !== start && c >= 0) {
    path.push(c);
    c = parent[c];
  }
  path.reverse();
  return { path, complete: found >= 0, expanded };
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

/** True if a straight segment between two points crosses no blocked tile (with a body radius). */
export function lineClear(size: number, blocked: (i: number) => boolean, x0: number, y0: number, x1: number, y1: number, radius = 0.2): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return true;
  const nx = (-dy / len) * radius, ny = (dx / len) * radius;
  const steps = Math.ceil(len / 0.3);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = x0 + dx * t, py = y0 + dy * t;
    for (let k = -1; k <= 1; k++) {
      const qx = Math.floor(px + nx * k), qy = Math.floor(py + ny * k);
      if (qx < 0 || qy < 0 || qx >= size || qy >= size) return false;
      if (blocked(qy * size + qx)) return false;
    }
  }
  return true;
}

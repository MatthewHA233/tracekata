// ══════════════════════════════════════════════
// 锚点域布局算法 — 语义投影 + 聚簇（照搬 solo-leveling 锚点域的零依赖实现）
//   · 幂迭代 PCA 取前两主成分，向量 → 2D 世界坐标（语义近 = 空间近）
//   · 余弦聚簇：并查集 + 自适应阈值 mean + 0.5σ，夹在 [0.35, 0.55]
//   · 重叠松弛把贴太近的球轻推开；簇成员 hash 用于簇名缓存
// ══════════════════════════════════════════════

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** 簇成员指纹：锚点 id 排序拼接的 FNV hash（成员不变 → 不重复起名） */
export function clusterMemberHash(anchorIds: readonly string[]): string {
  const joined = [...anchorIds].sort().join("|");
  let h = 2166136261;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function normalizeVec(v: number[]): void {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function powerIteration(rows: number[][], seed: string): number[] {
  const d = rows[0].length;
  const v = new Array<number>(d);
  for (let i = 0; i < d; i++) v[i] = hash01(seed + i) - 0.5;
  normalizeVec(v);
  for (let iter = 0; iter < 40; iter++) {
    const next = new Array<number>(d).fill(0);
    for (const row of rows) {
      const proj = dot(row, v);
      for (let i = 0; i < d; i++) next[i] += proj * row[i];
    }
    normalizeVec(next);
    for (let i = 0; i < d; i++) v[i] = next[i];
  }
  return v;
}

export interface WorldSpec {
  readonly w: number;
  readonly h: number;
  readonly pad: number;
}

/** 向量 → 世界坐标。两主成分各自缩放铺满画布（小样本下比等比缩放观感好）。 */
export function projectAnchors(
  entries: ReadonlyArray<{ id: string; vector: number[] }>,
  world: WorldSpec,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (entries.length === 0) return out;
  if (entries.length === 1) {
    out.set(entries[0].id, { x: world.w / 2, y: world.h / 2 });
    return out;
  }

  const d = entries[0].vector.length;
  const mean = new Array<number>(d).fill(0);
  for (const e of entries) for (let i = 0; i < d; i++) mean[i] += e.vector[i];
  for (let i = 0; i < d; i++) mean[i] /= entries.length;
  const centered = entries.map((e) => e.vector.map((x, i) => x - mean[i]));

  const p1 = powerIteration(centered, "pc1");
  const deflated = centered.map((row) => {
    const proj = dot(row, p1);
    return row.map((x, i) => x - proj * p1[i]);
  });
  const p2 = powerIteration(deflated, "pc2");

  const raw = centered.map((row) => ({ u: dot(row, p1), v: dot(row, p2) }));
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const r of raw) {
    if (r.u < uMin) uMin = r.u;
    if (r.u > uMax) uMax = r.u;
    if (r.v < vMin) vMin = r.v;
    if (r.v > vMax) vMax = r.v;
  }
  const uSpan = Math.max(uMax - uMin, 1e-6);
  const vSpan = Math.max(vMax - vMin, 1e-6);

  entries.forEach((e, idx) => {
    const r = raw[idx];
    out.set(e.id, {
      x: world.pad + ((r.u - uMin) / uSpan) * (world.w - world.pad * 2),
      y: world.pad + ((r.v - vMin) / vSpan) * (world.h - world.pad * 2),
    });
  });

  relaxOverlap(out, 56, world);
  return out;
}

/** 重叠松弛：把贴得过近的球轻推开，保持整体语义布局不变形 */
export function relaxOverlap(
  pos: Map<string, { x: number; y: number }>,
  minDist: number,
  world: WorldSpec,
): void {
  const ids = [...pos.keys()].sort();
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!;
        const b = pos.get(ids[j])!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;
        if (dist < 1e-3) {
          // 完全重合：按 id 哈希给个确定性方向
          const ang = hash01(ids[i] + ids[j]) * Math.PI * 2;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          dist = 1;
        }
        const push = (minDist - dist) / 2 / dist;
        pos.set(ids[i], clampToWorld({ x: a.x - dx * push, y: a.y - dy * push }, world));
        pos.set(ids[j], clampToWorld({ x: b.x + dx * push, y: b.y + dy * push }, world));
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function clampToWorld(p: { x: number; y: number }, world: WorldSpec): { x: number; y: number } {
  return {
    x: Math.max(world.pad, Math.min(world.w - world.pad, p.x)),
    y: Math.max(world.pad, Math.min(world.h - world.pad, p.y)),
  };
}

function cosineSim(a: number[], b: number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na * nb);
  return denom > 0 ? d / denom : 0;
}

/** 余弦聚簇：阈值随语料自身相似度分布走（mean + 0.5σ，夹 [0.35, 0.55]） */
export function clusterByCosine(
  entries: ReadonlyArray<{ id: string; vector: number[] }>,
): string[][] {
  if (entries.length === 0) return [];
  if (entries.length === 1) return [[entries[0].id]];

  const sims: Array<{ i: number; j: number; sim: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      sims.push({ i, j, sim: cosineSim(entries[i].vector, entries[j].vector) });
    }
  }
  const mean = sims.reduce((acc, s) => acc + s.sim, 0) / sims.length;
  const variance = sims.reduce((acc, s) => acc + (s.sim - mean) ** 2, 0) / sims.length;
  const threshold = Math.min(0.55, Math.max(0.35, mean + 0.5 * Math.sqrt(variance)));

  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = a;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const e of entries) parent.set(e.id, e.id);
  for (const s of sims) {
    if (s.sim > threshold) parent.set(find(entries[s.i].id), find(entries[s.j].id));
  }
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const root = find(e.id);
    const list = groups.get(root);
    if (list) list.push(e.id);
    else groups.set(root, [e.id]);
  }
  return [...groups.values()];
}

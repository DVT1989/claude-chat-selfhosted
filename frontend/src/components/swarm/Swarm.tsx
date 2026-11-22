'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { useAuthStore } from '@/lib/store';

/**
 * Swarm: all knowledge on one light canvas. A tiny own force simulation lays it out in 2D; a toggle
 * folds that flat layout open into a slowly turning 3D cloud with an own perspective projection
 * (no WebGL, no libraries). The loop pauses when the tab is hidden or the canvas is off screen,
 * runs at a capped frame rate when at rest, and with prefers-reduced-motion there is no rotation,
 * breathing or pulses and the 2D/3D switch is a short fade.
 */

type Kind = 'memory' | 'lesson' | 'skill' | 'proposal' | 'task' | 'chat';
interface GNode {
  id: string; kind: Kind; label: string; topic: string; weight: number; date: string | null;
  text?: string; pinned?: boolean; archived?: boolean; status?: string; ref?: string;
}
interface GEdge { a: string; b: string; kind: 'learned' | 'topic' | 'tag' | 'flow' }
interface Graph { nodes: GNode[]; edges: GEdge[]; at: string }

interface SNode {
  id: string; kind: Kind | 'bundle'; label: string; topic: string; weight: number;
  x: number; y: number; vx: number; vy: number; r: number; color: string;
  a: number; anchor: number; phase: number; born: number; fly: boolean; gone: boolean;
  src?: GNode; members?: GNode[]; bundleKind?: Kind;
  /** sine of the elevation this item gets in 3D (topic based, so clusters stay together) */
  sinE: number;
  /** last projection: screen position, radius, depth (0 far .. 1 near), z for sorting */
  sx: number; sy: number; sr: number; sd: number; sz: number;
}
interface Pulse { from: SNode; to: SNode; t0: number; dur: number }
interface SEdge { a: SNode; b: SNode; kind: GEdge['kind'] }

const MAX_NODES = 300;
const POLL_MS = 60_000;
const WORLD = 300;
const DIM_KEY = 'swarm-dim';
const PITCH0 = 0.34;            // resting tilt of the 3D cloud
const AUTO_ROT = 0.00011;       // rad per ms, about one turn a minute
const TWEEN_MS = 900;
// timer between frames at rest: about 25 fps for the turning cloud (20 on a large, high-dpi canvas such as a phone), 11 for the flat float
const FPS_3D = 30, FPS_3D_BIG = 44, FPS_2D = 80;
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrapAngle = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));

/** '#rrggbb' + alpha -> rgba(); gradients must not fade through transparent black */
function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}
/** Pre-rendered round sprites per colour: a wide glow and a soft (out of focus) dot. drawImage is far cheaper than a gradient per dot per frame. */
const spriteCache = new Map<string, HTMLCanvasElement>();
function sprite(color: string, kind: 'glow' | 'soft'): HTMLCanvasElement {
  const key = `${kind}${color}`;
  let c = spriteCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  if (kind === 'glow') { gr.addColorStop(0, rgba(color, 0.55)); gr.addColorStop(0.35, rgba(color, 0.2)); gr.addColorStop(1, rgba(color, 0)); }
  else { gr.addColorStop(0, rgba(color, 1)); gr.addColorStop(0.42, rgba(color, 0.92)); gr.addColorStop(1, rgba(color, 0)); }
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  spriteCache.set(key, c);
  return c;
}
function readDim(): number {
  try { const v = parseFloat(localStorage.getItem(DIM_KEY) ?? ''); return Number.isFinite(v) ? clamp01(v) : 0; } catch { return 0; }
}
function saveDim(v: number) {
  try { localStorage.setItem(DIM_KEY, String(Math.round(v * 1000) / 1000)); } catch { /* private mode */ }
}

export const KINDS: Array<{ k: Kind; label: string; color: string }> = [
  { k: 'memory', label: 'Feiten', color: '' },
  { k: 'lesson', label: 'Lessen', color: '#f59e0b' },
  { k: 'skill', label: 'Skills', color: '#8b5cf6' },
  { k: 'proposal', label: 'Voorstellen', color: '#c084fc' },
  { k: 'task', label: 'Taken', color: '#6366f1' },
  { k: 'chat', label: 'Gesprekken', color: '#38bdf8' },
];
const KIND_COLOR = Object.fromEntries(KINDS.map((k) => [k.k, k.color])) as Record<Kind, string>;
const KIND_NAME: Record<Kind, string> = { memory: 'Feit', lesson: 'Les', skill: 'Skill', proposal: 'Skill-voorstel', task: 'Terugkerende taak', chat: 'Gesprek' };
// topic colours for facts; amber, violet and sky stay reserved for the other kinds
const TOPIC_COLORS = ['#ec4899', '#10b981', '#14b8a6', '#84cc16', '#f43f5e', '#d946ef', '#22c55e', '#fb7185', '#2dd4bf', '#a3e635', '#e879f9', '#f472b6'];
const EDGE_STYLE: Record<GEdge['kind'], { alpha: number; len: number; k: number }> = {
  topic: { alpha: 0.09, len: 26, k: 0.05 },
  tag: { alpha: 0.06, len: 70, k: 0.008 },
  learned: { alpha: 0.2, len: 46, k: 0.025 },
  flow: { alpha: 0.4, len: 34, k: 0.07 },
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const topicColor = (t: string) => TOPIC_COLORS[hash(t) % TOPIC_COLORS.length];

/** Distance from the centre (0..1): pinned near the middle, archived at the rim. */
function anchorFor(n: GNode): number {
  if (n.kind === 'memory') return n.pinned ? 0.14 : n.archived ? 0.97 : 0.5;
  if (n.kind === 'proposal' && n.status === 'afgewezen') return 0.95;
  return { lesson: 0.62, skill: 0.4, proposal: 0.5, task: 0.58, chat: 0.82 }[n.kind] ?? 0.6;
}
function radiusFor(n: GNode): number {
  switch (n.kind) {
    case 'memory': return Math.min(15, 4 + Math.sqrt(Math.max(0, n.weight)) * 2);
    case 'lesson': return 4.5;
    case 'skill': return 8;
    case 'proposal': return 6.5;
    case 'task': return Math.min(11, 4 + n.weight);
    case 'chat': return Math.min(10, 3.5 + Math.sqrt(n.weight) * 1.6);
  }
}
function baseAlpha(n: SNode): number {
  if (n.src?.archived) return 0.32;
  if (n.src?.kind === 'proposal' && n.src.status === 'afgewezen') return 0.35;
  return 0.92;
}

/** Above MAX_NODES: collapse the biggest topics into one bundle each (pinned and the heaviest stay loose). */
function bundle(nodes: GNode[], expanded: Set<string>): { shown: Array<GNode | { id: string; members: GNode[]; kind: Kind; topic: string }>; owner: Map<string, string> } {
  const owner = new Map<string, string>();
  if (nodes.length <= MAX_NODES) return { shown: nodes, owner };
  const groups = new Map<string, GNode[]>();
  for (const n of nodes) {
    const k = `${n.kind}|${n.topic}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(n);
  }
  let total = nodes.length;
  const bundled = new Map<string, GNode[]>();
  const order = [...groups.entries()].filter(([k]) => !expanded.has(`b:${k}`)).sort((a, b) => b[1].length - a[1].length);
  for (const [k, list] of order) {
    if (total <= MAX_NODES) break;
    if (list.length < 5) continue;
    const sorted = [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.weight - a.weight);
    const rest = sorted.filter((n, i) => i >= 3 && !n.pinned);
    if (rest.length < 2) continue;
    bundled.set(k, rest);
    for (const n of rest) owner.set(n.id, `b:${k}`);
    total -= rest.length - 1;
  }
  const shown: Array<GNode | { id: string; members: GNode[]; kind: Kind; topic: string }> = nodes.filter((n) => !owner.has(n.id));
  for (const [k, members] of bundled) shown.push({ id: `b:${k}`, members, kind: members[0].kind, topic: members[0].topic });
  return { shown, owner };
}

function linkFor(n: GNode, isAdmin: boolean): { href: string; label: string } | null {
  const id = n.id.slice(2);
  switch (n.kind) {
    case 'memory': return { href: `/settings/geheugen?focus=${id}`, label: 'Openen in Geheugen' };
    case 'lesson': return isAdmin ? { href: `/settings/kennis?focus=${id}`, label: 'Openen in Gedeelde kennis' } : null;
    case 'skill': return { href: `/settings/skills?focus=${encodeURIComponent(n.ref ?? id)}`, label: 'Openen in Skills' };
    case 'proposal': return { href: `/settings/leerlus?focus=p-${id}`, label: 'Openen in Leerlus' };
    case 'task': return { href: `/settings/leerlus?focus=${encodeURIComponent(`t-${n.ref ?? ''}`)}`, label: 'Openen in Leerlus' };
    case 'chat': return { href: `/chat/${id}`, label: 'Gesprek openen' };
  }
}

export default function Swarm() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState('');
  const [off, setOff] = useState<Set<Kind>>(new Set());
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<SNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hits, setHits] = useState(0);
  const [is3d, setIs3d] = useState(() => readDim() >= 0.5);
  const rangeRef = useRef<HTMLInputElement>(null);

  // Everything the drawing loop needs lives in one ref: no React render per frame
  const sim = useRef({
    nodes: new Map<string, SNode>(), edges: [] as SEdge[], adj: new Map<string, Set<string>>(),
    heat: 0, cam: { x: 0, y: 0, s: 1 }, w: 0, h: 0, dpr: 1, userMoved: false,
    hover: null as SNode | null, sel: null as SNode | null, hitSet: null as Set<string> | null, off: new Set<Kind>(),
    reduced: false, raf: 0, timer: 0, visible: true, onScreen: true, lastDraw: 0, first: true,
    colors: { text: '#ece9f2', muted: '#a7a1b8', accent: '#D97757', bg: '#0b0a10' },
    // 2D -> 3D: dim 0 is the flat layout, 1 the full cloud; everything in between is a real state
    dim: readDim(), side: readDim() >= 0.5,
    tween: null as null | { from: number; to: number; t0: number; dur: number; yaw0: number; pitch0: number; pitch1: number },
    fade: null as null | { to: number; t0: number; switched: boolean },
    sliding: false, yaw: 0, pitch: PITCH0, vYaw: 0, vPitch: 0, dragging: false, lastT: 0,
    introT0: 0, pulses: [] as Pulse[], nextPulse: 0, order: [] as SNode[], shownDim: -1,
  });

  // ── data ────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/assistant/graph', { credentials: 'include', cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setGraph(d as Graph); setErr('');
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  // ── loop control ────────────────────────────────────────
  const kick = useCallback(() => {
    const s = sim.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
    if (s.raf || !s.visible || !s.onScreen) return;
    s.raf = requestAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // graph -> simulation nodes (keeps positions, new items fly in)
  useEffect(() => {
    if (!graph) return;
    const s = sim.current;
    const { shown } = bundle(graph.nodes, expanded);
    const now = performance.now();
    const seen = new Set<string>();
    let changed = false;
    const ownerOf = new Map<string, string>();
    for (const item of shown) {
      seen.add(item.id);
      const isBundle = 'members' in item;
      const g = isBundle ? null : (item as GNode);
      if (isBundle) for (const m of item.members) ownerOf.set(m.id, item.id);
      let n = s.nodes.get(item.id);
      const color = item.kind === 'memory' ? topicColor(item.topic) : KIND_COLOR[item.kind];
      const anchor = g ? anchorFor(g) : 0.6;
      const r = g ? radiusFor(g) : Math.min(20, 7 + Math.sqrt((item as { members: GNode[] }).members.length) * 1.8);
      if (!n) {
        // seed: angle by topic so clusters start near each other; new items come from outside
        const ang = ((hash(item.topic) % 360) / 180) * Math.PI + (hash(item.id) % 100) / 160;
        const rad = s.first ? anchor * WORLD + (hash(item.id) % 40) - 20 : WORLD * 1.6;
        // 3D elevation: one band per topic plus a little own jitter, so a cluster stays a clump
        const sinE = Math.max(-0.92, Math.min(0.92, ((hash(`e${item.topic}`) % 1000) / 1000 - 0.5) * 1.5 + ((hash(`j${item.id}`) % 1000) / 1000 - 0.5) * 0.45));
        n = { id: item.id, kind: isBundle ? 'bundle' : item.kind, label: '', topic: item.topic, weight: 0,
          x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, vx: 0, vy: 0, r, color, a: 0, anchor,
          phase: (hash(item.id) % 1000) / 159, born: s.first ? 0 : now, fly: !s.first, gone: false,
          sinE, sx: 0, sy: 0, sr: 0, sd: 1, sz: 0 };
        s.nodes.set(item.id, n);
        changed = true;
      } else if (isBundle && (n.members?.length ?? 0) < item.members.length && !s.first) {
        n.born = now; // a bundle that got a new member pulses
      }
      n.gone = false;
      n.r = r; n.color = color; n.anchor = anchor; n.topic = item.topic;
      if (isBundle) {
        n.members = item.members; n.bundleKind = item.kind; n.weight = item.members.length;
        n.label = `${item.topic} (${item.members.length})`; n.src = undefined;
      } else {
        n.src = g!; n.label = g!.label; n.weight = g!.weight;
      }
    }
    for (const n of s.nodes.values()) if (!seen.has(n.id) && !n.gone) { n.gone = true; changed = true; }

    // edges onto what is shown (members of a bundle point to the bundle), without duplicates
    const pick = (id: string) => s.nodes.get(ownerOf.get(id) ?? id);
    const key = new Set<string>();
    s.edges = [];
    s.adj = new Map();
    for (const e of graph.edges) {
      const a = pick(e.a), b = pick(e.b);
      if (!a || !b || a === b || a.gone || b.gone) continue;
      const k = a.id < b.id ? `${a.id}>${b.id}` : `${b.id}>${a.id}`;
      if (key.has(k)) continue;
      key.add(k);
      s.edges.push({ a, b, kind: e.kind });
      if (!s.adj.has(a.id)) s.adj.set(a.id, new Set());
      if (!s.adj.has(b.id)) s.adj.set(b.id, new Set());
      s.adj.get(a.id)!.add(b.id); s.adj.get(b.id)!.add(a.id);
    }

    if (s.first) {
      s.first = false;
      s.heat = 1;
      // warm up out of sight, so the first frame is already a calm cloud
      for (let i = 0; i < (s.reduced ? 320 : 90); i++) { tick(s, s.heat); s.heat *= 0.985; }
      if (s.reduced) s.heat = 0;
      fit(s);
      s.introT0 = s.reduced ? 0 : performance.now(); // dots grow out of the middle
    } else if (changed) {
      s.heat = Math.max(s.heat, 0.25);
    }
    kick();
  }, [graph, expanded, kick]);

  // filters and search into the loop
  useEffect(() => {
    const s = sim.current;
    s.off = off;
    const t = q.trim().toLowerCase();
    if (!t) { s.hitSet = null; setHits(0); }
    else {
      const set = new Set<string>();
      for (const n of s.nodes.values()) {
        if (n.gone) continue;
        const hay = n.members ? n.members.map((m) => `${m.label} ${m.text ?? ''}`).join(' ') : `${n.label} ${n.src?.text ?? ''}`;
        if (`${hay} ${n.topic}`.toLowerCase().includes(t)) set.add(n.id);
      }
      s.hitSet = set; setHits(set.size);
    }
    kick();
  }, [off, q, graph, expanded, kick]);

  useEffect(() => { sim.current.sel = selected; kick(); }, [selected, kick]);

  // ── simulation ──────────────────────────────────────────
  function tick(s: typeof sim.current, heat: number) {
    const list = [...s.nodes.values()].filter((n) => !n.gone);
    const len = list.length;
    for (let i = 0; i < len; i++) {
      const n = list[i];
      const d = Math.hypot(n.x, n.y) || 1;
      const f = (n.anchor * WORLD - d) * 0.02 * heat;
      n.vx += (n.x / d) * f; n.vy += (n.y / d) * f;
      for (let j = i + 1; j < len; j++) {
        const m = list[j];
        const dx = m.x - n.x, dy = m.y - n.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 14400) continue;
        if (d2 < 1) d2 = 1;
        const dd = Math.sqrt(d2);
        const min = n.r + m.r + 3;
        let push = (22 * heat) / d2;
        if (dd < min) push += ((min - dd) / dd) * 0.35;
        n.vx -= dx * push; n.vy -= dy * push; m.vx += dx * push; m.vy += dy * push;
      }
    }
    for (const e of s.edges) {
      const st = EDGE_STYLE[e.kind];
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = ((d - st.len) / d) * st.k * heat;
      e.a.vx += dx * f; e.a.vy += dy * f; e.b.vx -= dx * f; e.b.vy -= dy * f;
    }
    for (const n of list) {
      // new items fly in a bit faster, then settle like the rest
      const decay = n.fly ? 0.82 : 0.6;
      n.vx *= decay; n.vy *= decay;
      n.x += n.vx; n.y += n.vy;
      if (n.fly && Math.hypot(n.x, n.y) < WORLD * 1.05) n.fly = false;
      if (n.fly) { const d = Math.hypot(n.x, n.y) || 1; n.vx -= (n.x / d) * 1.6; n.vy -= (n.y / d) * 1.6; }
    }
  }

  function fit(s: typeof sim.current) {
    if (!s.w || !s.h) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of s.nodes.values()) {
      if (n.gone) continue;
      minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
    }
    if (!isFinite(minX)) { s.cam = { x: 0, y: 0, s: 1 }; return; }
    const pad = 40;
    const sc = Math.min((s.w - pad) / (maxX - minX || 1), (s.h - pad) / (maxY - minY || 1));
    s.cam = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, s: Math.max(0.25, Math.min(2.5, sc)) };
  }

  /** 0..1 how far the intro has grown this dot out of the middle (inner rings first) */
  function introOf(s: typeof sim.current, n: SNode, now: number): number {
    if (!s.introT0) return 1;
    const p = (now - s.introT0 - n.anchor * 520) / 820;
    return p >= 1 ? 1 : p <= 0 ? 0 : easeOut(p);
  }

  /**
   * Projects every visible dot onto the screen. The 2D layout is folded open by the slider: each
   * dot keeps its distance to the centre (pinned inside, archived at the rim) and tilts up or down
   * by its own elevation, the cloud turns (yaw, pitch) and gets perspective. The result is blended
   * with the flat position by dim, so 0 is exactly the old 2D picture and 1 the full cloud.
   */
  function project(s: typeof sim.current, t: number, now: number) {
    const m = s.dim;
    const cyw = Math.cos(s.yaw), syw = Math.sin(s.yaw), cp = Math.cos(s.pitch), sp = Math.sin(s.pitch);
    const D = WORLD * 2.3, k3 = 1 / (1 + 0.1 * m);
    const zr = Math.max(0.6, Math.min(1.6, s.cam.s));
    const live = !s.reduced;
    const order: SNode[] = [];
    for (const n of s.nodes.values()) {
      if (n.a <= 0.01) continue;
      let x = n.x, y = n.y;
      // a light drift that never fully stops
      if (live) { x += Math.sin(t * 0.00035 + n.phase) * 3 + Math.sin(t * 0.00011 + n.phase * 0.7) * 1.5; y += Math.cos(t * 0.00028 + n.phase * 1.3) * 3; }
      const ip = introOf(s, n, now);
      if (ip < 1) { x *= ip; y *= ip; }
      let X = x, Y = y, Z = 0;
      if (m > 0.0005) {
        const d = Math.hypot(x, y), ce = Math.sqrt(1 - n.sinE * n.sinE);
        const x3 = x * ce, y3 = y * ce, z3 = d * n.sinE;
        const xr = x3 * cyw - z3 * syw, zr1 = x3 * syw + z3 * cyw;
        const yr = y3 * cp - zr1 * sp, zz = y3 * sp + zr1 * cp;
        X = x + (xr - x) * m; Y = y + (yr - y) * m; Z = zz * m;
      }
      const f = (D / (D - Z)) * k3;
      // breathing: size and glow, each dot on its own phase
      const br = live ? 1 + Math.sin(t * 0.0011 + n.phase * 2.1) * 0.07 : 1;
      n.sx = (X * f - s.cam.x) * s.cam.s + s.w / 2;
      n.sy = (Y * f - s.cam.y) * s.cam.s + s.h / 2;
      n.sr = n.r * zr * f * br * (0.15 + 0.85 * ip);
      n.sz = Z;
      n.sd = clamp01(0.5 + Z / (1.7 * WORLD));
      order.push(n);
    }
    // painter's order: far first, so near dots cover far ones
    if (m > 0.01) order.sort((a, b) => a.sz - b.sz);
    s.order = order;
  }

  function targetAlpha(s: typeof sim.current, n: SNode): number {
    if (n.gone) return 0;
    const kind = n.kind === 'bundle' ? n.bundleKind! : n.kind;
    if (s.off.has(kind)) return 0;
    let a = n.kind === 'bundle' ? 0.8 : baseAlpha(n);
    const focus = s.hover ?? s.sel;
    if (focus && !focus.gone) {
      if (n !== focus && !s.adj.get(focus.id)?.has(n.id)) a *= 0.16;
      else a = Math.max(a, 0.85);
    }
    if (s.hitSet) a *= s.hitSet.has(n.id) ? 1 : 0.18;
    return a;
  }

  function stopLoop() {
    const s = sim.current;
    if (s.raf) cancelAnimationFrame(s.raf);
    if (s.timer) clearTimeout(s.timer);
    s.raf = 0; s.timer = 0;
  }

  function animateDim(to: number) {
    const s = sim.current;
    s.sliding = false;
    if (s.reduced) { s.tween = null; s.fade = { to, t0: performance.now(), switched: false }; kick(); return; }
    s.fade = null;
    const from = s.dim;
    const pitch1 = to === 0 ? 0 : from < 0.05 ? PITCH0 : s.pitch;
    s.tween = { from, to, t0: performance.now(), dur: TWEEN_MS * Math.max(0.4, Math.abs(to - from)), yaw0: wrapAngle(s.yaw), pitch0: from < 0.05 ? 0 : s.pitch, pitch1 };
    s.yaw = wrapAngle(s.yaw);
    kick();
  }

  function setDim(s: typeof sim.current, v: number) {
    s.dim = v;
    const side = v >= 0.5;
    if (side !== s.side) { s.side = side; setIs3d(side); }
    // keep the slider in step during animations without a React render per frame
    const el = rangeRef.current;
    if (el && !s.sliding) { const val = String(Math.round(v * 1000)); if (el.value !== val) el.value = val; }
  }

  function frame(t: number) {
    const s = sim.current;
    s.raf = 0;
    if (!s.visible || !s.onScreen) { s.lastT = 0; return; }
    const dt = s.lastT ? Math.min(100, t - s.lastT) : 16;
    s.lastT = t;
    const now = performance.now();
    let busy = false;

    // 2D <-> 3D
    if (s.tween) {
      const tw = s.tween;
      const p = clamp01((now - tw.t0) / tw.dur), e = easeInOut(p);
      setDim(s, tw.from + (tw.to - tw.from) * e);
      if (tw.to === 0) s.yaw = tw.yaw0 * (1 - e);           // turn back to the front while folding flat
      s.pitch = tw.pitch0 + (tw.pitch1 - tw.pitch0) * e;
      if (p >= 1) { s.tween = null; setDim(s, tw.to); saveDim(tw.to); }
      busy = true;
    }
    if (s.fade) {
      const p = (now - s.fade.t0) / 260;
      if (p >= 0.5 && !s.fade.switched) { s.fade.switched = true; if (s.fade.to === 0) s.yaw = 0; s.pitch = s.fade.to ? PITCH0 : 0; setDim(s, s.fade.to); saveDim(s.fade.to); }
      if (p >= 1) s.fade = null;
      busy = true;
    }
    if (s.sliding) {
      // while the slider is held the cloud turns to the front, so folding stays readable
      const k = Math.min(1, dt / 260);
      s.yaw += (0 - wrapAngle(s.yaw)) * k;
      s.pitch += (PITCH0 * s.dim - s.pitch) * k;
      if (Math.abs(wrapAngle(s.yaw)) > 0.002 || Math.abs(PITCH0 * s.dim - s.pitch) > 0.002) busy = true;
    }

    // rotation: slow auto turn, drag with inertia
    if (s.dim > 0.0005 && !s.dragging) {
      if (Math.abs(s.vYaw) > 1e-5 || Math.abs(s.vPitch) > 1e-5) {
        s.yaw += s.vYaw * dt;
        s.pitch = Math.max(-1.3, Math.min(1.3, s.pitch + s.vPitch * dt));
        const k = Math.exp(-dt / 520);
        s.vYaw *= k; s.vPitch *= k;
        busy = true;
      } else { s.vYaw = 0; s.vPitch = 0; }
      if (!s.reduced && !s.sliding && !(s.tween && s.tween.to === 0)) {
        s.yaw += AUTO_ROT * dt * s.dim * (s.hover || s.sel ? 0.18 : 1);
      }
      s.yaw = wrapAngle(s.yaw);
    }

    const cooled = s.heat < 0.004;
    if (!cooled) { tick(s, s.heat); s.heat += (0 - s.heat) * 0.0228; }
    busy = draw(s, t, now) || busy || !cooled;
    if (busy) s.raf = requestAnimationFrame(frame);
    // at rest a timer instead of rAF lets the page sleep between frames. With reduced motion
    // nothing moves, so the loop stops.
    else if (!s.reduced) {
      const gap = s.dim > 0.02 ? (s.w * s.h * s.dpr * s.dpr > 1.1e6 ? FPS_3D_BIG : FPS_3D) : FPS_2D;
      s.timer = window.setTimeout(() => { s.timer = 0; if (!s.raf) s.raf = requestAnimationFrame(frame); }, gap);
    } else s.lastT = 0;
  }

  /** Light pulses that run along a line now and then, mostly from a chat to what was learned there. */
  function spawnPulse(s: typeof sim.current, now: number) {
    s.nextPulse = now + 900 + Math.random() * 1700;
    if (s.pulses.length >= 4 || !s.edges.length) return;
    const learned = s.edges.filter((e) => e.kind === 'learned' || e.kind === 'flow');
    const pool = learned.length && Math.random() < 0.75 ? learned : s.edges;
    for (let i = 0; i < 6; i++) {
      const e = pool[(Math.random() * pool.length) | 0];
      if (e.a.a < 0.3 || e.b.a < 0.3) continue;
      const fromA = e.a.kind === 'chat' ? true : e.b.kind === 'chat' ? false : Math.random() < 0.5;
      s.pulses.push({ from: fromA ? e.a : e.b, to: fromA ? e.b : e.a, t0: now, dur: 1300 + Math.random() * 700 });
      return;
    }
  }

  /** Draws one frame. Returns true while something still changes (fades, intro, new items). */
  function draw(s: typeof sim.current, t: number, now: number): boolean {
    const cv = canvasRef.current;
    if (!cv) return false;
    const ctx = cv.getContext('2d');
    if (!ctx) return false;
    s.lastDraw = t;
    let busy = false;
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.clearRect(0, 0, s.w, s.h);

    // fades
    for (const n of s.nodes.values()) {
      const ta = targetAlpha(s, n);
      const da = ta - n.a;
      if (Math.abs(da) > 0.01) { n.a += da * (s.reduced ? 0.25 : 0.14); busy = true; } else n.a = ta;
      if (n.gone && n.a <= 0.01) s.nodes.delete(n.id);
    }
    if (s.introT0) { if (now - s.introT0 > 2300) s.introT0 = 0; else busy = true; }
    project(s, t, now);
    const m = s.dim;
    // reduced motion: the 2D/3D switch is a short dip to transparent
    const fadeMul = s.fade ? Math.abs(1 - 2 * clamp01((now - s.fade.t0) / 260)) : 1;
    // depth cue: far is fainter and softer, near is full and crisp
    const fogOf = (n: SNode) => 1 - m * (1 - n.sd) * 0.62;

    // edges
    const focus = s.hover ?? s.sel;
    ctx.lineWidth = 1;
    for (const e of s.edges) {
      if (e.a.a <= 0.01 || e.b.a <= 0.01) continue;
      const lit = focus && (e.a === focus || e.b === focus);
      const al = Math.min(e.a.a, e.b.a) * (lit ? 0.7 : EDGE_STYLE[e.kind].alpha) * Math.min(fogOf(e.a), fogOf(e.b)) * fadeMul;
      if (al < 0.01) continue;
      ctx.globalAlpha = al;
      ctx.strokeStyle = e.kind === 'flow' || e.kind === 'learned' ? (lit ? s.colors.text : e.b.color) : s.colors.muted;
      ctx.beginPath(); ctx.moveTo(e.a.sx, e.a.sy); ctx.lineTo(e.b.sx, e.b.sy); ctx.stroke();
    }

    // light pulses along the lines
    if (!s.reduced) {
      if (now >= s.nextPulse) spawnPulse(s, now);
      s.pulses = s.pulses.filter((p) => now - p.t0 < p.dur && !p.from.gone && !p.to.gone);
      for (const p of s.pulses) {
        if (p.from.a < 0.2 || p.to.a < 0.2) continue;
        const k = (now - p.t0) / p.dur, e = easeInOut(k);
        const x = p.from.sx + (p.to.sx - p.from.sx) * e, y = p.from.sy + (p.to.sy - p.from.sy) * e;
        const al = Math.sin(Math.PI * k) * Math.min(p.from.a, p.to.a) * fadeMul;
        const R = 9 * (0.8 + 0.4 * ((p.from.sd + p.to.sd) / 2) * m + 0.2 * (1 - m));
        ctx.globalAlpha = al * 0.9;
        ctx.drawImage(sprite(p.to.color, 'glow'), x - R, y - R, R * 2, R * 2);
        ctx.globalAlpha = al; ctx.fillStyle = s.colors.text;
        ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
      }
    }

    // dots
    for (const n of s.order) {
      const x = n.sx, y = n.sy, r = n.sr;
      const fog = fogOf(n);
      const a = n.a * fog * fadeMul;
      if (a < 0.01) continue;
      // soft glow that breathes with the dot; only for the bigger ones, the small ones only breathe in size
      if (!s.reduced && n.a > 0.4 && r >= 6) {
        const g = 0.17 + Math.sin(t * 0.0011 + n.phase * 2.1) * 0.08;
        const R = r * 2.6;
        ctx.globalAlpha = a * g;
        ctx.drawImage(sprite(n.color, 'glow'), x - R, y - R, R * 2, R * 2);
      }
      // far dots are drawn out of focus (a soft sprite, a bit larger), near ones crisp
      // (only a narrow depth band draws both, so the change is a crossfade, not a pop)
      const soft = clamp01((m * (0.45 - n.sd)) / 0.12);
      if (soft > 0.02) {
        const R = r * 1.6;
        ctx.globalAlpha = a * 0.85 * soft;
        ctx.drawImage(sprite(n.color, 'soft'), x - R, y - R, R * 2, R * 2);
      }
      if (soft < 0.98) {
        ctx.globalAlpha = a * (1 - soft);
        ctx.fillStyle = n.color;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      if (n.kind === 'bundle') {
        ctx.globalAlpha = a;
        ctx.setLineDash([2, 3]); ctx.strokeStyle = n.color; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(x, y, r + 3.5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
      if (n.src?.pinned || n.kind === 'proposal') {
        ctx.strokeStyle = n.kind === 'proposal' ? n.color : s.colors.text; ctx.lineWidth = 1.2;
        ctx.globalAlpha = a * 0.7;
        ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, Math.PI * 2); ctx.stroke();
      }
      if (s.hitSet?.has(n.id) || n === s.sel) {
        ctx.globalAlpha = n.a * 0.9 * fadeMul; ctx.strokeStyle = s.colors.accent; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
      }
      // a new item lands with a soft pulse
      if (n.born) {
        const age = (now - n.born) / 1600;
        if (age < 1) {
          busy = true;
          ctx.globalAlpha = (1 - age) * 0.6 * fadeMul; ctx.strokeStyle = n.color; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, y, r + 2 + age * 22, 0, Math.PI * 2); ctx.stroke();
        } else n.born = 0;
      }
    }

    // labels: only the item under the finger/cursor, its neighbours and search hits
    const labelled: SNode[] = [];
    if (focus && focus.a > 0.01) {
      labelled.push(focus);
      for (const id of s.adj.get(focus.id) ?? []) { const mm = s.nodes.get(id); if (mm && labelled.length < 10) labelled.push(mm); }
    }
    if (s.hitSet) for (const id of s.hitSet) { const mm = s.nodes.get(id); if (mm && labelled.length < 24 && !labelled.includes(mm)) labelled.push(mm); }
    if (labelled.length) {
      ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.textBaseline = 'middle';
      for (const n of labelled) {
        if (n.a < 0.3) continue;
        const txt = n.label.length > 42 ? `${n.label.slice(0, 41)}…` : n.label;
        const x = n.sx + n.sr + 6, y = n.sy;
        const w = ctx.measureText(txt).width;
        ctx.globalAlpha = 0.85 * fadeMul; ctx.fillStyle = s.colors.bg;
        ctx.beginPath(); ctx.roundRect(x - 4, y - 9, w + 8, 18, 6); ctx.fill();
        ctx.globalAlpha = (n === focus ? 1 : 0.8) * fadeMul; ctx.fillStyle = s.colors.text;
        ctx.fillText(txt, x, y);
      }
    }
    ctx.globalAlpha = 1;
    return busy;
  }

  // ── canvas setup: size, theme, visibility, input ─────────
  useEffect(() => {
    const s = sim.current;
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    s.reduced = mq.matches;
    if (s.dim < 0.0005) s.pitch = 0;
    if (rangeRef.current) rangeRef.current.value = String(Math.round(s.dim * 1000));
    const onMq = () => { s.reduced = mq.matches; kick(); };
    mq.addEventListener('change', onMq);

    const readColors = () => {
      const cs = getComputedStyle(wrap);
      const v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
      // resolve color-mix() for --g-bg-base through a real property
      const probe = document.createElement('span');
      probe.style.color = 'var(--g-bg-base)'; wrap.appendChild(probe);
      const bg = getComputedStyle(probe).color; probe.remove();
      s.colors = { text: v('--text', '#ece9f2'), muted: v('--muted', '#a7a1b8'), accent: v('--accent', '#D97757'), bg: bg || '#0b0a10' };
      kick();
    };
    readColors();
    const themeObs = new MutationObserver(readColors);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const w = Math.round(r.width), h = Math.round(r.height);
      if (w === s.w && h === s.h) return;
      s.w = w; s.h = h;
      s.dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(w * s.dpr); cv.height = Math.round(h * s.dpr);
      cv.style.width = `${w}px`; cv.style.height = `${h}px`;
      if (!s.userMoved) fit(s);
      kick();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const onVis = () => { s.visible = !document.hidden; if (s.visible) kick(); else stopLoop(); };
    document.addEventListener('visibilitychange', onVis);
    const io = new IntersectionObserver(([en]) => {
      s.onScreen = en.isIntersecting;
      if (s.onScreen) kick(); else stopLoop();
    });
    io.observe(cv);

    // input: pan (2D) or turn (3D) with one pointer, pinch with two, wheel zoom, tap selects
    const pts = new Map<number, { x: number; y: number }>();
    let down: { x: number; y: number; t: number; moved: boolean; turn: boolean; lt: number } | null = null;
    let pinch: { d: number; s: number; mx: number; my: number; cx: number; cy: number } | null = null;
    const local = (e: PointerEvent | WheelEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    // hit test on the projected positions of the last frame; in 3D the nearest dot wins
    const nodeAt = (x: number, y: number): SNode | null => {
      let best: SNode | null = null, bd = Infinity;
      for (let i = s.order.length - 1; i >= 0; i--) {
        const n = s.order[i];
        if (n.gone || n.a < 0.1) continue;
        const d = Math.hypot(n.sx - x, n.sy - y);
        if (d < n.sr + 8) {
          if (d < n.sr) return n;       // directly on top of a dot: the front one
          if (d < bd) { bd = d; best = n; }
        }
      }
      return best;
    };
    const zoomAt = (x: number, y: number, ns: number) => {
      ns = Math.max(0.2, Math.min(6, ns));
      const wx = (x - s.w / 2) / s.cam.s + s.cam.x, wy = (y - s.h / 2) / s.cam.s + s.cam.y;
      s.cam = { s: ns, x: wx - (x - s.w / 2) / ns, y: wy - (y - s.h / 2) / ns };
      s.userMoved = true; kick();
    };
    const onDown = (e: PointerEvent) => {
      cv.setPointerCapture(e.pointerId);
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 1) {
        down = { x: p.x, y: p.y, t: performance.now(), moved: false, turn: s.dim >= 0.5, lt: performance.now() };
        s.vYaw = 0; s.vPitch = 0;
      }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: s.cam.s, mx, my, cx: s.cam.x, cy: s.cam.y };
        if (down) down.moved = true;
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      const prev = pts.get(e.pointerId);
      if (!prev) {
        if (e.pointerType === 'mouse') {
          const h = nodeAt(p.x, p.y);
          if (h !== s.hover) { s.hover = h; cv.style.cursor = h ? 'pointer' : 'grab'; kick(); }
        }
        return;
      }
      pts.set(e.pointerId, p);
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const ns = Math.max(0.2, Math.min(6, pinch.s * (d / pinch.d)));
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const wx = (pinch.mx - s.w / 2) / pinch.s + pinch.cx, wy = (pinch.my - s.h / 2) / pinch.s + pinch.cy;
        s.cam = { s: ns, x: wx - (mx - s.w / 2) / ns, y: wy - (my - s.h / 2) / ns };
        s.userMoved = true; kick();
        return;
      }
      if (down) {
        if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) > 6) { down.moved = true; cv.style.cursor = 'grabbing'; }
        if (down.moved && down.turn) {
          // 3D: drag turns the cloud; the last speed carries on as inertia after release
          const nowT = performance.now(), dtm = Math.max(8, nowT - down.lt);
          const dy = (p.x - prev.x) * 0.006, dp = (p.y - prev.y) * 0.006;
          s.yaw = wrapAngle(s.yaw + dy); s.pitch = Math.max(-1.3, Math.min(1.3, s.pitch + dp));
          s.vYaw = s.vYaw * 0.4 + (dy / dtm) * 0.6; s.vPitch = s.vPitch * 0.4 + (dp / dtm) * 0.6;
          down.lt = nowT; s.dragging = true; kick();
        } else if (down.moved) {
          s.cam.x -= (p.x - prev.x) / s.cam.s; s.cam.y -= (p.y - prev.y) / s.cam.s;
          s.userMoved = true; kick();
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      const p = local(e);
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0 && down) {
        if (!down.moved) {
          const n = nodeAt(p.x, p.y);
          if (n?.kind === 'bundle') setExpanded((x) => new Set(x).add(n.id));
          setSelected(n && n.kind !== 'bundle' ? n : null);
        }
        if (s.dragging) {
          s.dragging = false;
          // held still before letting go, or reduced motion: no coasting
          if (s.reduced || performance.now() - down.lt > 90) { s.vYaw = 0; s.vPitch = 0; }
          kick();
        }
        down = null;
        cv.style.cursor = s.hover ? 'pointer' : 'grab';
      }
    };
    const onLeave = () => { if (s.hover) { s.hover = null; kick(); } };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, s.cam.s * Math.exp(-e.deltaY * 0.0015));
    };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      mq.removeEventListener('change', onMq);
      themeObs.disconnect(); ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
      cv.removeEventListener('pointerleave', onLeave);
      cv.removeEventListener('wheel', onWheel);
      stopLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kick]);

  const counts = useMemo(() => {
    const c = new Map<Kind, number>();
    for (const n of graph?.nodes ?? []) c.set(n.kind, (c.get(n.kind) ?? 0) + 1);
    return c;
  }, [graph]);

  const toggle = (k: Kind) => setOff((o) => { const x = new Set(o); if (x.has(k)) x.delete(k); else x.add(k); return x; });
  const resetView = () => {
    const s = sim.current;
    s.userMoved = false; s.vYaw = 0; s.vPitch = 0;
    if (s.dim > 0.0005) s.pitch = PITCH0;
    fit(s); kick();
  };
  const sel = selected?.src;
  const link = sel ? linkFor(sel, isAdmin) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoeken" aria-label="Zoeken in de swarm" type="search"
          className="w-44 bg-(--input) border border-(--border) rounded-lg px-3 py-1.5 text-sm text-(--text) outline-none focus:border-(--accent)" />
        {q.trim() && <span className="text-xs text-(--muted) tabular-nums">{hits} {hits === 1 ? 'treffer' : 'treffers'}</span>}
        <div className="swarm-chips flex gap-1.5 overflow-x-auto max-w-full">
          {KINDS.filter((k) => counts.get(k.k)).map((k) => (
            <button key={k.k} onClick={() => toggle(k.k)} aria-pressed={!off.has(k.k)}
              className={clsx('swarm-chip shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-[color,border-color,opacity] duration-200',
                off.has(k.k) ? 'border-(--border) text-(--muted) opacity-60' : 'border-[color-mix(in_srgb,var(--text)_22%,transparent)] text-(--text)')}>
              <span className="w-2 h-2 rounded-full" style={{ background: k.color || 'conic-gradient(#ec4899, #10b981, #84cc16, #d946ef, #ec4899)' }} />
              {k.label} <span className="opacity-60 tabular-nums">{counts.get(k.k)}</span>
            </button>
          ))}
        </div>
      </div>

      <div ref={wrapRef} className="swarm-wrap relative rounded-xl border border-(--border) overflow-hidden">
        <canvas ref={canvasRef} className="block touch-none select-none" style={{ cursor: 'grab' }} aria-label="Swarm van alle kennis" role="img" />
        {!graph && !err && <div className="absolute inset-0 grid place-items-center text-sm text-(--muted)">Laden...</div>}
        {err && <div className="absolute inset-0 grid place-items-center text-sm text-red-400 px-6 text-center">{err}</div>}
        {graph && !graph.nodes.length && <div className="absolute inset-0 grid place-items-center text-sm text-(--muted) px-6 text-center">Nog niets om te tonen. Na een paar gesprekken vult de swarm zich vanzelf.</div>}
        <button onClick={resetView} className="swarm-fit absolute top-2 right-2 px-2.5 py-1 rounded-lg text-xs text-(--muted) hover:text-(--text) border border-(--border)">Passend</button>

        <div className="swarm-dim absolute bottom-3 left-1/2 -translate-x-1/2 sm:left-3 sm:translate-x-0 p-1 rounded-full border border-(--border)" role="group" aria-label="Weergave">
          <div className="relative grid grid-cols-2">
            <span aria-hidden className="swarm-dim-pill absolute inset-y-0 left-0 w-1/2 rounded-full" style={{ transform: is3d ? 'translateX(100%)' : 'none' }} />
            <button onClick={() => animateDim(0)} aria-pressed={!is3d} className={clsx('swarm-dim-label relative px-3.5 py-1 rounded-full text-xs font-medium transition-colors duration-300', !is3d ? 'text-white' : 'text-(--muted) hover:text-(--text)')}>2D</button>
            <button onClick={() => animateDim(1)} aria-pressed={is3d} className={clsx('swarm-dim-label relative px-3.5 py-1 rounded-full text-xs font-medium transition-colors duration-300', is3d ? 'text-white' : 'text-(--muted) hover:text-(--text)')}>3D</button>
          </div>
        </div>

        {selected && sel && (
          <div key={selected.id} className="swarm-panel absolute left-2 right-2 bottom-2 sm:left-auto sm:right-3 sm:bottom-3 sm:w-80 rounded-xl border border-(--border) p-3.5 space-y-2" role="dialog" aria-label={KIND_NAME[sel.kind]}>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: selected.color }} />
              <span className="text-xs text-(--muted) flex-1 truncate">
                {KIND_NAME[sel.kind]}{sel.kind !== 'chat' && sel.topic ? ` · ${sel.topic}` : ''}{sel.pinned ? ' · vastgezet' : ''}{sel.archived ? ' · gearchiveerd' : ''}{sel.status ? ` · ${sel.status}` : ''}
              </span>
              <button onClick={() => setSelected(null)} aria-label="Sluiten" className="text-(--muted) hover:text-(--text) -m-1 p-1">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <p className="text-sm text-(--text) whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{sel.text || sel.label}</p>
            <div className="flex items-center gap-3 text-xs text-(--muted)">
              {sel.kind === 'memory' && <span>{sel.weight > 0 ? `${sel.weight}x gebruikt` : 'nog niet gebruikt'}</span>}
              {sel.kind === 'task' && <span>{sel.weight}x gezien</span>}
              {sel.kind === 'chat' && <span>{sel.weight} {sel.weight === 1 ? 'ding' : 'dingen'} geleerd</span>}
              {sel.date && <span>{new Date(sel.date).toLocaleDateString('nl-NL')}</span>}
              {link && <Link href={link.href} className="ml-auto text-(--accent) hover:underline">{link.label}</Link>}
            </div>
          </div>
        )}
      </div>
      <p className="text-xs text-(--muted)">Sleep om te verschuiven, in 3D om te draaien. Scroll of knijp om te zoomen. Met de schuif onderaan vouw je de swarm open van 2D naar 3D. Tik op een bolletje voor de tekst; een gestippelde bol is een gebundeld onderwerp en klapt open met een tik.</p>
    </div>
  );
}

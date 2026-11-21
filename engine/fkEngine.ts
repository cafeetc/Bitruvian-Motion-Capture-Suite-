import { ANATOMICAL_LIMITS, EFFECTOR_ROLES, LIMB_CHAINS } from './rigMetadata';
import type {
  BondStatusItem,
  CameraBox,
  Keyframe,
  PoseSnapshot,
  RawRigDef,
  RigNode,
  RigPiece,
} from './types';

export const DEG = Math.PI / 180;
const IDENTITY = [1, 0, 0, 1, 0, 0];

export function mkCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function decImage(src: string): Promise<ImageBitmap | HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(im).then(resolve, () => resolve(im));
      } else {
        resolve(im);
      }
    };
    im.onerror = () => reject(new Error('Failed to decode sprite asset'));
    im.src = src;
  });
}

export function setPieceBitmap(
  p: RigPiece,
  bm: CanvasImageSource & { width: number; height: number },
): void {
  if (!p.bm0) p.bm0 = bm;
  p.bm = bm;
  const st = Math.max(1, Math.min(8, Math.floor(Math.min(p.w, p.h) / 16)));
  const mw = Math.ceil(p.w / st);
  const mh = Math.ceil(p.h / st);
  const o = mkCanvas(mw, mh).getContext('2d', {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  o.drawImage(bm, 0, 0, mw, mh);
  const d = o.getImageData(0, 0, mw, mh).data;
  const m = new Uint8Array(mw * mh);
  for (let i = 0; i < m.length; i++) {
    m[i] = d[i * 4 + 3] > 30 ? 1 : 0;
  }
  p.m = m;
  p.mw = mw;
  p.mh = mh;
  p.st = st;
}

export function addDigits(def: RawRigDef): void {
  if (def.dg) return;
  def.dg = 1;
  const map: Record<string, RawRigDef['nodes'][number]> = {};
  def.nodes.forEach((n) => {
    map[n.id] = n;
  });
  for (const s of ['R', 'L'] as const) {
    const m = s === 'L';
    const X = (x: number) => (m ? 2504 - x : x);
    const handNode = map['hand' + s];
    if (!handNode?.pieces?.length) continue;
    def.nodes.push(
      { id: 'thumb' + s, name: 'Thumb ' + s, parent: 'hand' + s, pivot: [X(545), 4030], pieces: [] },
      { id: 'thumbTip' + s, name: 'Thumb tip ' + s, parent: 'thumb' + s, pivot: [X(609), 4347], pieces: [], lock: 1 },
      { id: 'finger' + s, name: 'Finger ' + s, parent: 'hand' + s, pivot: [X(492), 4183], pieces: [] },
      { id: 'fingerTip' + s, name: 'Finger tip ' + s, parent: 'finger' + s, pivot: [X(492), 4697], pieces: [], lock: 1 },
      { id: 'toe' + s, name: 'Toe tip ' + s, parent: 'foot' + s, pivot: [m ? 2296 : 192, 7593], pieces: [], lock: 1 },
    );
  }
}

export function addJoints(def: RawRigDef): void {
  if (def.jn) return;
  def.jn = 1;
  const map: Record<string, RawRigDef['nodes'][number]> = {};
  def.nodes.forEach((n) => {
    map[n.id] = n;
  });
  if (map.head) {
    def.nodes.push(
      { id: 'lip', name: 'Upper lip (chin pivot)', parent: 'head', pivot: [1259, 685], pieces: [] },
      { id: 'chinTip', name: 'Chin point', parent: 'lip', pivot: [1259, 890], pieces: [], lock: 1 },
    );
  }
  if (map.femurR && map.femurL && map.pelvis) {
    map.femurR.pivot = [990, 3598];
    map.femurL.pivot = [1521, 3598];
    map.pelvis.bar = ['femurR', 'femurL'];
    if (map.pelvis.pieces && map.pelvis.pieces.length >= 2 && !map.hipR && !map.hipL) {
      const sorted = map.pelvis.pieces.slice().sort((a, b) => a.x - b.x);
      map.pelvis.pieces = [];
      def.nodes.push(
        { id: 'hipR', name: 'Right hip', parent: 'pelvis', pivot: [1257, 3382], pieces: [sorted[0]] },
        { id: 'hipL', name: 'Left hip', parent: 'pelvis', pivot: [1257, 3382], pieces: [sorted[1]] },
      );
      map.femurR.parent = 'hipR';
      map.femurL.parent = 'hipL';
    }
  }
  if (map.thorax && map.thorax.pieces && !map.ribR && !map.ribL) {
    const ribs = map.thorax.pieces.filter((p) => p.name === 'Ribcage').sort((a, b) => a.x - b.x);
    if (ribs.length >= 2) {
      map.thorax.pieces = map.thorax.pieces.filter((p) => p.name !== 'Ribcage');
      map.thorax.bar = ['ribR', 'ribL'];
      def.nodes.push(
        { id: 'ribR', name: 'Right ribcage', parent: 'thorax', pivot: [1257.5, 2377.5], pieces: [ribs[0]] },
        { id: 'ribL', name: 'Left ribcage', parent: 'thorax', pivot: [1257.5, 2377.5], pieces: [ribs[1]] },
      );
    }
  }
  for (const s of ['L', 'R'] as const) {
    const br = map['brace' + s];
    if (!br || !map.neck) continue;
    br.pivot = map.neck.pivot.slice() as [number, number];
    const bw = br.pieces?.find((p) => p.name === 'Backshoulder');
    if (bw) {
      bw.x = s === 'L' ? 1147 : 643;
      bw.y = 1115;
      def.nodes.push({
        id: 'wing' + s,
        name: 'Back wing ' + s,
        parent: 'brace' + s,
        pivot: [bw.x + bw.w / 2, bw.y + bw.h / 2],
        pieces: [],
        lock: 1,
        ghost: 1,
      });
    }
    def.nodes.push({
      id: 'swivelTip' + s,
      name: 'Swivel tip ' + s,
      parent: 'swivel' + s,
      pivot: s === 'L' ? [2031, 1334] : [483, 1390],
      pieces: [],
      lock: 1,
    });
  }
}

export function parentOf(n: RigNode, by: Record<string, RigNode>): RigNode | null {
  return n.parent ? by[n.parent] ?? null : null;
}

export function pos(n: RigNode, by: Record<string, RigNode>, out: [number, number] = [0, 0]): [number, number] {
  const par = parentOf(n, by);
  const w = par ? par.w : IDENTITY;
  const x = n.piv[0] + (n.parent ? 0 : n.tx);
  const y = n.piv[1] + (n.parent ? 0 : n.ty);
  out[0] = w[0] * x + w[2] * y + w[4];
  out[1] = w[1] * x + w[3] * y + w[5];
  return out;
}

export function setW(n: RigNode, rad: number, by: Record<string, RigNode>): void {
  const par = parentOf(n, by);
  const p = par ? par.w : IDENTITY;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const fx = n.flipX ? -1 : 1;
  const px = n.piv[0];
  const py = n.piv[1];
  const e = px - fx * c * px + s * py + n.tx;
  const f = py - fx * s * px - c * py + n.ty;
  const m00 = fx * c;
  const m01 = -s;
  const m10 = fx * s;
  const m11 = c;
  const w = n.w;
  w[0] = p[0] * m00 + p[2] * m10;
  w[1] = p[1] * m00 + p[3] * m10;
  w[2] = p[0] * m01 + p[2] * m11;
  w[3] = p[1] * m01 + p[3] * m11;
  w[4] = p[0] * e + p[2] * f + p[4];
  w[5] = p[1] * e + p[3] * f + p[5];
}

export function normalizeDeg(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

export function clampAnatomicalAngle(n: RigNode, deg: number, constrainLimits: boolean): number {
  const norm = normalizeDeg(deg);
  if (!constrainLimits) return norm;
  const [min, max] = n.limits;
  return Math.max(min, Math.min(max, norm));
}

export function clampRealisticShoulder(
  n: RigNode,
  deg: number,
  by: Record<string, RigNode>,
  prometheusWings = false,
): number {
  const norm = normalizeDeg(deg);
  if (prometheusWings) return norm;
  if (n.id === 'braceL' || n.id === 'braceR') {
    return Math.max(-8, Math.min(8, norm));
  }
  if (n.id === 'swivelL' || n.id === 'swivelR') {
    const txAng = by.thorax ? by.thorax.ang : 0;
    const rel = Math.max(-18, Math.min(18, normalizeDeg(norm - txAng)));
    return normalizeDeg(txAng + rel);
  }
  if (n.id === 'acromionL' || n.id === 'acromionR') {
    return Math.max(-22, Math.min(22, norm));
  }
  return norm;
}

export function getTensionRatio(n: RigNode): { ratio: number; nearLimit: boolean; atLimit: boolean } {
  const [min, max] = n.limits;
  if (min <= -179 && max >= 179) {
    return { ratio: 0, nearLimit: false, atLimit: false };
  }
  const span = Math.max(1, max - min);
  const distMin = n.ang - min;
  const distMax = max - n.ang;
  const nearest = Math.min(distMin, distMax);
  const normMargin = nearest / (span * 0.5);
  return {
    ratio: Math.max(0, Math.min(1, 1 - normMargin)),
    nearLimit: nearest <= 8 && nearest > 0.5,
    atLimit: nearest <= 0.5,
  };
}

export function worldToLocalAngle(n: RigNode, targetWorldRad: number, by: Record<string, RigNode>): number {
  const par = parentOf(n, by);
  const p = par ? par.w : IDENTITY;
  const parentWorldRad = Math.atan2(p[1], p[0]);
  return normalizeDeg((targetWorldRad - parentWorldRad) / DEG);
}

export function bondAng(
  n: RigNode,
  by: Record<string, RigNode>,
  bondOn: boolean,
  prometheusWings = false,
): number {
  const b = n.bond;
  if (!b || !bondOn || !b.aim) return n.ang;
  const ac = by[b.aim.to];
  if (!ac || !n.parent || !b.parent) return n.ang;
  const lw = by[n.parent].w;
  const tw = by[b.parent].w;
  const bp = b.piv;
  const nx = tw[0] * bp[0] + tw[2] * bp[1] + tw[4];
  const ny = tw[1] * bp[0] + tw[3] * bp[1] + tw[5];
  const f = b.aim.from;
  const L0 = Math.hypot(f[0] - bp[0], f[1] - bp[1]);
  const lo = b.aim.min * L0;
  const hi = b.aim.max * L0;
  const px = n.piv[0];
  const py = n.piv[1];
  const ax = ac.piv[0] - px;
  const ay = ac.piv[1] - py;
  const sideSign = n.id.endsWith('L') ? 1 : -1;
  const txAng = by[b.parent] ? by[b.parent].ang : 0;

  const v = (a: number) => {
    const r = a * DEG;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const X = px + c * ax - s * ay;
    const Y = py + s * ax + c * ay;
    const wx = lw[0] * X + lw[2] * Y + lw[4];
    const wy = lw[1] * X + lw[3] * Y + lw[5];
    const d = Math.hypot(wx - nx, wy - ny);
    const stretchTol = 1.12;
    const loSoft = lo * 0.92;
    const hiSoft = hi * stretchTol;
    const distErr = d < loSoft ? loSoft - d : d > hiSoft ? d - hiSoft : 0;
    const lateralSigned = ((wx - nx) * tw[0] + (wy - ny) * tw[1]) * sideSign;
    const minLat = prometheusWings ? 60 : 240;
    const latErr = lateralSigned < minLat ? (minLat - lateralSigned) * 4 : 0;
    const relAng = Math.abs(normalizeDeg(a - txAng));
    const maxRel = prometheusWings ? 75 : 32;
    const angErr = relAng > maxRel ? (relAng - maxRel) * 25 : 0;
    return distErr + latErr + angErr;
  };

  const seed = prometheusWings
    ? n.ang
    : normalizeDeg(txAng + Math.max(-28, Math.min(28, normalizeDeg(n.ang - txAng))));
  if (v(seed) === 0) return seed;

  for (let i = 1; i <= 360; i++) {
    for (const s of [1, -1]) {
      const a = seed + s * i * 0.5;
      if (v(a) === 0) {
        let bad = a - s * 0.5;
        let good = a;
        for (let j = 0; j < 18; j++) {
          const m = (bad + good) / 2;
          if (v(m) === 0) good = m;
          else bad = m;
        }
        return good;
      }
    }
  }

  let best = seed;
  let bv = v(best);
  for (let i = -180; i <= 180; i++) {
    const a = seed + i;
    const e = v(a);
    if (e < bv) {
      bv = e;
      best = a;
    }
  }
  return best;
}

export function setAim(n: RigNode, by: Record<string, RigNode>, bondOn: boolean, prometheusWings = false): void {
  if (!n.aim || !n.parent) return;
  const pw = by[n.parent].w;
  const p = n.piv;
  const F = n.aim.from;
  const ac = by[n.aim.to];
  if (!ac || !ac.parent) return;
  const aw = by[ac.parent].w;
  const Qx = aw[0] * ac.piv[0] + aw[2] * ac.piv[1] + aw[4];
  const Qy = aw[1] * ac.piv[0] + aw[3] * ac.piv[1] + aw[5];
  const X = pw[0] * p[0] + pw[2] * p[1] + pw[4];
  const Y = pw[1] * p[0] + pw[3] * p[1] + pw[5];
  const vx = Qx - X;
  const vy = Qy - Y;
  const dist = Math.hypot(vx, vy) || 1;
  const L0 = Math.hypot(F[0] - p[0], F[1] - p[1]) || 1;

  const maxTilt = prometheusWings ? 45 : 8;
  const clampedAng = Math.max(-maxTilt, Math.min(maxTilt, normalizeDeg(n.ang)));
  let a = Math.atan2(vy, vx) - Math.atan2(F[1] - p[1], F[0] - p[0]) + clampedAng * DEG;
  if (!prometheusWings) {
    const thoraxRad = Math.atan2(pw[1], pw[0]);
    const relRad = Math.atan2(Math.sin(a - thoraxRad), Math.cos(a - thoraxRad));
    const maxSwing = 12 * DEG;
    a = thoraxRad + Math.max(-maxSwing, Math.min(maxSwing, relRad));
  }

  const ux = vx / dist;
  const uy = vy / dist;
  const delta = dist - L0;
  const rawSlide = delta * (prometheusWings ? 0.62 : 0.5);
  const [minS, maxS] = bondOn
    ? [-0.24 * L0, 0.14 * L0]
    : [-0.14 * L0, 0.08 * L0];
  const span = Math.max(1, (maxS - minS) * 0.5);
  const mid = (minS + maxS) * 0.5;
  const slide = mid + span * Math.tanh((rawSlide - mid) / span);

  const c = Math.cos(a);
  const s = Math.sin(a);
  const w = n.w;
  w[0] = c;
  w[1] = s;
  w[2] = -s;
  w[3] = c;
  w[4] = X + ux * slide - (c * p[0] - s * p[1]);
  w[5] = Y + uy * slide - (s * p[0] + c * p[1]);
}

export function solveRig(
  nodes: RigNode[],
  by: Record<string, RigNode>,
  bondOn: boolean,
  wingPop = 0,
): void {
  const activeWings = wingPop > 0.05;
  for (const n of nodes) {
    if (n.id === 'wingL' || n.id === 'wingR') {
      n.ghost = !activeWings;
      n.piv = n.rest.slice() as [number, number];
    }
    if (n.aim) {
      setAim(n, by, bondOn, activeWings);
    } else {
      n.eff = bondAng(n, by, bondOn, activeWings);
      setW(n, n.eff * DEG, by);
    }
  }
}

export function getBondStatus(nodes: RigNode[], bondOn: boolean): BondStatusItem[] {
  if (!bondOn) return [];
  const items: BondStatusItem[] = [];
  for (const n of nodes) {
    if (n.bond) {
      const delta = n.eff - n.ang;
      items.push({
        side: n.id.slice(-1),
        delta,
        strained: Math.abs(delta) > 0.05,
      });
    }
  }
  return items;
}

export function assetTips(nodes: RigNode[]): void {
  for (const n of nodes) {
    n.at = null;
    if (n.id === 'hipR') {
      n.at = [825, 3115];
      continue;
    }
    if (n.id === 'hipL') {
      n.at = [1689, 3115];
      continue;
    }
    if (n.id === 'ribR') {
      n.at = [696, 2648];
      continue;
    }
    if (n.id === 'ribL') {
      n.at = [1808, 2592];
      continue;
    }
    if (!n.pieces.length || n.aim || n.bar || nodes.some((k) => k.parent === n.id)) continue;
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    for (const p of n.pieces) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.w);
      y1 = Math.max(y1, p.y + p.h);
    }
    let best: [number, number] | null = null;
    let bd = 40;
    const candidates: Array<[number, number]> = [
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
      [(x0 + x1) / 2, y0],
      [(x0 + x1) / 2, y1],
      [x0, (y0 + y1) / 2],
      [x1, (y0 + y1) / 2],
    ];
    for (const c of candidates) {
      const d = Math.hypot(c[0] - n.piv[0], c[1] - n.piv[1]);
      if (d > bd) {
        bd = d;
        best = c;
      }
    }
    n.at = best;
  }
}

export function buildRigGraph(rawInput: RawRigDef, includeDigitsAndJoints = true) {
  const def: RawRigDef = JSON.parse(JSON.stringify(rawInput));
  if (includeDigitsAndJoints) {
    addDigits(def);
    addJoints(def);
  }
  const chainLookup: Record<string, string> = {};
  for (const ch of LIMB_CHAINS) {
    if (ch.swiv) chainLookup[ch.swiv] = ch.id;
    chainLookup[ch.upper] = ch.id;
    chainLookup[ch.lower] = ch.id;
    chainLookup[ch.effector] = ch.id;
  }
  let nodes: RigNode[] = def.nodes.map((n) => ({
    id: n.id,
    name: n.name || n.id,
    parent: n.parent || null,
    aim: n.aim || null,
    pieces: (n.pieces || []) as RigPiece[],
    piv: n.pivot.slice() as [number, number],
    rest: n.pivot.slice() as [number, number],
    ang: n.ang || 0,
    tx: 0,
    ty: 0,
    w: new Float64Array(6),
    eff: 0,
    bond: null,
    lock: !!n.lock,
    ghost: !!n.ghost,
    bar: n.bar || null,
    at: null,
    limits: ANATOMICAL_LIMITS[n.id] ?? [-180, 180],
    effectorRole: EFFECTOR_ROLES[n.id] ?? null,
    chainId: chainLookup[n.id] ?? null,
    flipX: !!n.flipX,
  }));

  const by: Record<string, RigNode> = {};
  nodes.forEach((n) => {
    by[n.id] = n;
  });

  nodes.forEach((n) => {
    if (n.aim) {
      const ac = by[n.aim.to];
      const sw = ac && ac.parent ? by[ac.parent] : null;
      if (sw) sw.bond = n;
    }
  });

  const ord: RigNode[] = [];
  const seen = new Set<string>();
  const dep = (n: RigNode) => {
    const d: Array<string | null> = [n.parent];
    if (n.aim) d.push(n.aim.to);
    return d;
  };
  const vis = (n: RigNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    for (const d of dep(n)) {
      if (d && by[d]) vis(by[d]);
    }
    if (n.bond && n.bond.parent && by[n.bond.parent]) {
      vis(by[n.bond.parent]);
    }
    ord.push(n);
  };
  nodes.forEach(vis);
  nodes = ord;
  assetTips(nodes);

  const root = nodes.find((n) => !n.parent) || nodes[0];
  const pieces: RigPiece[] = [];
  nodes.forEach((n) =>
    n.pieces.forEach((p) => {
      p.node = n;
      p.i0 = p.i;
      p.wing = p.name === 'Backshoulder';
      pieces.push(p);
    }),
  );
  pieces.sort((a, b) => b.i - a.i);

  return {
    W: def.W || 2500,
    H: def.H || 8742,
    nodes,
    by,
    root,
    pieces,
  };
}

export function getPieceWorldMatrix(
  p: RigPiece,
  out: Float64Array = new Float64Array(6),
): Float64Array {
  const n = p.node;
  if (!n) {
    out.set(IDENTITY);
    return out;
  }
  out.set(n.w);
  return out;
}

const TMP_MAT = new Float64Array(6);

export function hitTestPiece(
  q: [number, number],
  pieces: RigPiece[],
): { node: RigNode; piece: RigPiece } | null {
  for (let k = pieces.length - 1; k >= 0; k--) {
    const p = pieces[k];
    if (!p.m || !p.node || !p.mw || !p.st) continue;
    const w = getPieceWorldMatrix(p, TMP_MAT);
    const det = w[0] * w[3] - w[1] * w[2];
    if (!det) continue;
    const dx = q[0] - w[4];
    const dy = q[1] - w[5];
    const x = (w[3] * dx - w[2] * dy) / det - p.x;
    const y = (-w[1] * dx + w[0] * dy) / det - p.y;
    if (x < 0 || y < 0 || x >= p.w || y >= p.h) continue;
    if (p.m[((y / p.st) | 0) * p.mw + ((x / p.st) | 0)]) {
      return { node: p.node, piece: p };
    }
  }
  return null;
}

export function samplePieceWorldMask(p: RigPiece, wx: number, wy: number): boolean {
  if (!p.m || !p.node || !p.mw || !p.mh || !p.st) return false;
  const w = getPieceWorldMatrix(p, TMP_MAT);
  const det = w[0] * w[3] - w[1] * w[2];
  if (!det) return false;
  const dx = wx - w[4];
  const dy = wy - w[5];
  const x = (w[3] * dx - w[2] * dy) / det - p.x;
  const y = (-w[1] * dx + w[0] * dy) / det - p.y;
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) return false;
  const mx = Math.min(p.mw - 1, Math.max(0, (x / p.st) | 0));
  const my = Math.min(p.mh - 1, Math.max(0, (y / p.st) | 0));
  return p.m[my * p.mw + mx] > 0;
}

export function fitBoxParams(box: CameraBox, canvasW: number, canvasH: number, fill = 0.88) {
  const bw = Math.max(1, box.x1 - box.x0);
  const bh = Math.max(1, box.y1 - box.y0);
  const z = Math.min((canvasW * fill) / bw, (canvasH * fill) / bh);
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  return {
    z,
    ox: canvasW / 2 - cx * z,
    oy: canvasH / 2 - cy * z,
  };
}

export function computeModelFrame(
  by: Record<string, RigNode>,
  pieces: RigPiece[],
  W: number,
  H: number,
  canvasW: number,
  canvasH: number,
  dpr = 1,
): { z: number; ox: number; oy: number } {
  let x0 = 1e9;
  let x1 = -1e9;
  let y0 = 1e9;
  let y1 = -1e9;
  let hasBounds = false;

  for (const p of pieces) {
    hasBounds = true;
    const w = p.node ? getPieceWorldMatrix(p, TMP_MAT) : null;
    if (w && (w[0] !== 0 || w[1] !== 0 || w[2] !== 0 || w[3] !== 0)) {
      const corners: Array<[number, number]> = [
        [p.x, p.y],
        [p.x + p.w, p.y],
        [p.x, p.y + p.h],
        [p.x + p.w, p.y + p.h],
      ];
      for (const [cx, cy] of corners) {
        const wx = w[0] * cx + w[2] * cy + w[4];
        const wy = w[1] * cx + w[3] * cy + w[5];
        x0 = Math.min(x0, wx);
        x1 = Math.max(x1, wx);
        y0 = Math.min(y0, wy);
        y1 = Math.max(y1, wy);
      }
    }
  }

  for (const id in by) {
    const n = by[id];
    const p = pos(n, by);
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      hasBounds = true;
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  }

  if (hasBounds && x1 > x0 && y1 > y0) {
    const figH = Math.max(1, y1 - y0);
    const centerX = W === 2500 ? 1257 : (x0 + x1) / 2;
    const figW =
      W === 2500
        ? Math.max(1, 2 * Math.max(centerX - x0, x1 - centerX))
        : Math.max(1, x1 - x0);
    const topPad = Math.max(20 * dpr, canvasH * 0.055);
    const bottomPad = Math.max(20 * dpr, canvasH * 0.055);
    const sidePad = Math.max(18 * dpr, canvasW * 0.04);
    const availW = Math.max(60, canvasW - 2 * sidePad);
    const availH = Math.max(60, canvasH - topPad - bottomPad);
    const z = Math.min(availW / figW, availH / figH);
    const ox = canvasW / 2 - centerX * z;
    const oy = topPad + (availH - figH * z) * 0.5 - y0 * z;
    return { z, ox, oy };
  }

  return fitBoxParams({ x0: 0, y0: 0, x1: W, y1: H }, canvasW, canvasH, 0.9);
}

export function computeFramingCamera(
  framing: 'full-figure' | 'upper-body' | 'portrait-bust' | 'closeup-head',
  by: Record<string, RigNode>,
  pieces: RigPiece[],
  W: number,
  H: number,
  canvasW: number,
  canvasH: number,
  dpr = 1,
): { z: number; ox: number; oy: number } {
  if (framing === 'full-figure') {
    return computeModelFrame(by, pieces, W, H, canvasW, canvasH, dpr);
  }

  const focusNodeIds =
    framing === 'closeup-head'
      ? ['head', 'neck', 'lip', 'chinTip']
      : framing === 'portrait-bust'
      ? ['head', 'neck', 'thorax', 'acromionL', 'acromionR', 'ribL', 'ribR', 'humerusL', 'humerusR']
      : ['head', 'neck', 'thorax', 'lumbar', 'pelvis', 'handL', 'handR', 'hipL', 'hipR'];

  let x0 = 1e9;
  let x1 = -1e9;
  let y0 = 1e9;
  let y1 = -1e9;
  let found = false;

  for (const id of focusNodeIds) {
    const n = by[id];
    if (!n) continue;
    const p = pos(n, by);
    found = true;
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
    for (const pc of n.pieces) {
      const w = getPieceWorldMatrix(pc, TMP_MAT);
      const corners: Array<[number, number]> = [
        [pc.x, pc.y],
        [pc.x + pc.w, pc.y],
        [pc.x, pc.y + pc.h],
        [pc.x + pc.w, pc.y + pc.h],
      ];
      for (const [cx, cy] of corners) {
        const wx = w[0] * cx + w[2] * cy + w[4];
        const wy = w[1] * cx + w[3] * cy + w[5];
        x0 = Math.min(x0, wx);
        x1 = Math.max(x1, wx);
        y0 = Math.min(y0, wy);
        y1 = Math.max(y1, wy);
      }
    }
  }

  if (!found || x1 <= x0 || y1 <= y0) {
    return computeModelFrame(by, pieces, W, H, canvasW, canvasH, dpr);
  }

  const padX = framing === 'closeup-head' ? 280 : 320;
  const padY = framing === 'closeup-head' ? 220 : 280;
  return fitBoxParams(
    { x0: x0 - padX, y0: y0 - padY, x1: x1 + padX, y1: y1 + padY },
    canvasW,
    canvasH,
    0.84,
  );
}

export function capturePoseSnapshot(
  nodes: RigNode[],
  root: RigNode,
): PoseSnapshot {
  const pose: Record<string, number> = {};
  const flipX: Record<string, boolean> = {};
  for (const n of nodes) {
    pose[n.id] = Math.round(n.ang * 100) / 100;
    if (n.flipX) flipX[n.id] = true;
  }
  return {
    pose,
    root: [Math.round(root.tx * 10) / 10, Math.round(root.ty * 10) / 10],
    flipX,
  };
}

export function applyPoseSnapshot(
  snap: PoseSnapshot,
  nodes: RigNode[],
  by: Record<string, RigNode>,
  root: RigNode,
  bondOn: boolean,
): void {
  for (const n of nodes) {
    n.ang = snap.pose[n.id] ?? 0;
    n.flipX = !!(snap.flipX && snap.flipX[n.id]);
  }
  root.tx = snap.root[0] ?? 0;
  root.ty = snap.root[1] ?? 0;
  solveRig(nodes, by, bondOn, 0);
}

export function exportBskJson(
  nodes: RigNode[],
  by: Record<string, RigNode>,
  W: number,
  H: number,
  keyframes?: Keyframe[],
) {
  const bones = nodes.map((n) => {
    const p = n.parent && by[n.parent] ? by[n.parent].rest : [0, 0];
    return {
      name: n.id,
      ...(n.parent ? { parent: n.parent } : {}),
      x: Math.round((n.rest[0] - p[0]) * 100) / 100,
      y: Math.round((n.rest[1] - p[1]) * 100) / 100,
      rotation: Math.round(n.ang * 100) / 100,
    };
  });
  return {
    id: 'bitruvius-mocap',
    name: 'Bitruvian Mocap Rig',
    version: '1.1',
    width: W,
    height: H,
    bones,
    keyframes: keyframes ?? [],
    slots: [],
    ik: [],
  };
}

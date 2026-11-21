import {
  DEG,
  clampAnatomicalAngle,
  clampRealisticShoulder,
  getBondStatus,
  getTensionRatio,
  normalizeDeg,
  parentOf,
  pos,
  solveRig,
} from './fkEngine';
import { LIMB_CHAINS } from './rigMetadata';
import type {
  CoMPoint,
  IKConfig,
  IKMode,
  IKPinEntry,
  LimbChainDef,
  PerspHandle,
  PerspectiveState,
  RetargetFrameResult,
  RetargetOptions,
  RigNode,
} from './types';

export const DEFAULT_GROUND_Y = 7600;
export const GROUND_TOL = 32;

export const PERSP_DEFAULT: PerspectiveState = {
  enabled: true,
  groundY: DEFAULT_GROUND_Y,
  horizonY: 3170,
  vpX: 1257,
  floorScale: 420,
  tiltDownDeg: 5,
  depthSpread: 0.55,
};

export const DEFAULT_IK_CONFIG: IKConfig = {
  mode: 'fluid',
  solver: 'fabrik',
  iterations: 10,
  tolerance: 1.5,
  softness: 0.12,
  swivelFollow: 0.65,
  spineStiffness: 0.55,
  footGravity: true,
  groundY: DEFAULT_GROUND_Y,
  allowStretch: false,
  bendOverrides: {},
};

export const IK_MODE_LABELS: Record<IKMode, string> = {
  fk: 'Pure FK',
  fluid: 'Fluid FABRIK',
  balance: 'Balance + IK',
  pinFeet: 'Pin Feet',
  pinAll: 'Pin Feet + Hands',
  pinFull: 'Pin Full Rig',
};

export const EFFECTOR_IDS = ['footL', 'footR', 'handL', 'handR', 'head'] as const;
export const FBIK_CHAIN_NODES = new Set(['head', 'neck', 'thorax', 'lumbar', 'pelvis', 'shinL', 'shinR']);

const IDENTITY = [1, 0, 0, 1, 0, 0];

function transformLocalPt(n: RigNode, lx: number, ly: number): [number, number] {
  const w = n.w;
  return [w[0] * lx + w[2] * ly + w[4], w[1] * lx + w[3] * ly + w[5]];
}

export function groundYAt(
  wx: number,
  groundY: number,
  vpX = 1257,
  tiltDownDeg = 0,
): number {
  return groundY + (wx - vpX) * Math.tan(tiltDownDeg * DEG);
}

export function getGroundTiltHandlePos(persp: PerspectiveState): [number, number] {
  const x = persp.vpX + 900;
  return [x, groundYAt(x, persp.groundY, persp.vpX, persp.tiltDownDeg)];
}

export function getWorldDir(
  n: RigNode,
  localTip: [number, number] | null,
  by: Record<string, RigNode>,
): number {
  const a = pos(n, by);
  const t = localTip ?? [n.piv[0], n.piv[1] + 200];
  const w = n.w;
  const bx = w[0] * t[0] + w[2] * t[1] + w[4];
  const byp = w[1] * t[0] + w[3] * t[1] + w[5];
  return Math.atan2(byp - a[1], bx - a[0]);
}

export function setWorldDirExact(
  n: RigNode,
  localTip: [number, number],
  targetWorldRad: number,
  by: Record<string, RigNode>,
): void {
  const par = parentOf(n, by);
  const pW = par ? par.w : IDENTITY;
  const det = pW[0] * pW[3] - pW[1] * pW[2] || 1;
  const wx = Math.cos(targetWorldRad);
  const wy = Math.sin(targetWorldRad);
  const lx = (pW[3] * wx - pW[2] * wy) / det;
  const ly = (-pW[1] * wx + pW[0] * wy) / det;
  const fx = n.flipX ? -1 : 1;
  const effDx = fx * (localTip[0] - n.piv[0]);
  const effDy = localTip[1] - n.piv[1];
  const tipLocalRad = Math.atan2(effDy, effDx);
  n.ang = normalizeDeg((Math.atan2(ly, lx) - tipLocalRad) / DEG);
}

export function findLimbChainForNode(nodeId: string): LimbChainDef | null {
  const mapped =
    nodeId.startsWith('thumb') || nodeId.startsWith('finger')
      ? 'hand' + nodeId.slice(-1)
      : nodeId.startsWith('toe')
      ? 'foot' + nodeId.slice(-1)
      : nodeId;
  return LIMB_CHAINS.find((c) => c.effector === mapped) ?? null;
}

export function limbLengths(c: LimbChainDef, by: Record<string, RigNode>): [number, number] {
  const U = by[c.upper];
  const L = by[c.lower];
  const E = by[c.effector];
  if (!U || !L || !E) return [1000, 1000];
  return [
    Math.hypot(L.piv[0] - U.piv[0], L.piv[1] - U.piv[1]),
    Math.hypot(E.piv[0] - L.piv[0], E.piv[1] - L.piv[1]),
  ];
}

function resolveBendSign(
  c: LimbChainDef,
  U: RigNode,
  L: RigNode,
  config: IKConfig,
  bendHint = 0,
): number {
  const override = config.bendOverrides[c.id];
  if (override) return Math.sign(override);
  if (bendHint) return Math.sign(bendHint);
  if (Math.abs(L.ang) > 4) {
    return (L.ang > 0 ? 1 : -1) * (U.flipX ? -1 : 1);
  }
  return c.bendSign;
}

export function solveAnalyticalLimbIK(
  c: LimbChainDef,
  target: [number, number],
  nodes: RigNode[],
  by: Record<string, RigNode>,
  bondOn: boolean,
  wingPop: number,
  config: IKConfig,
  constrainLimits: boolean,
  bendHint = 0,
): void {
  solveRig(nodes, by, bondOn, wingPop);
  const U = by[c.upper];
  const L = by[c.lower];
  const E = by[c.effector];
  if (!U || !L || !E) return;

  const par = parentOf(U, by);
  const pW = par ? par.w : IDENTITY;
  const det = pW[0] * pW[3] - pW[1] * pW[2] || 1;
  const dx = target[0] - pW[4];
  const dy = target[1] - pW[5];
  const tx = (pW[3] * dx - pW[2] * dy) / det;
  const ty = (-pW[1] * dx + pW[0] * dy) / det;

  const fx = U.flipX ? -1 : 1;
  const P1: [number, number] = [U.piv[0], U.piv[1]];
  const P2: [number, number] = [U.flipX ? 2 * P1[0] - L.piv[0] : L.piv[0], L.piv[1]];
  const P3: [number, number] = [U.flipX ? 2 * P1[0] - E.piv[0] : E.piv[0], E.piv[1]];
  const L1 = Math.hypot(P2[0] - P1[0], P2[1] - P1[1]) || 1;
  const L2 = Math.hypot(P3[0] - P2[0], P3[1] - P2[1]) || 1;
  const base1 = Math.atan2(P2[1] - P1[1], P2[0] - P1[0]);
  const base2 = Math.atan2(P3[1] - P2[1], P3[0] - P2[0]);
  const restDiff = normalizeDeg((base2 - base1) / DEG);

  const rx = tx - P1[0];
  const ry = ty - P1[1];
  const dist = Math.hypot(rx, ry) || 1;
  const aim = Math.atan2(ry, rx);

  const hardMax = L1 + L2 - 4;
  const softness = (L1 + L2) * Math.max(0, Math.min(0.3, config.softness));
  const softStart = hardMax - softness;
  const hardInput = softStart + 1.4 * softness;

  if (dist >= hardInput) {
    U.ang = clampAnatomicalAngle(U, (aim - base1) / DEG, constrainLimits);
    L.ang = clampAnatomicalAngle(L, -restDiff * fx, constrainLimits);
  } else {
    const minFold = Math.abs(L1 - L2) + 12;
    let d = Math.max(minFold, dist);
    if (softness > 1 && dist > softStart) {
      const u = Math.min(1, (dist - softStart) / (1.4 * softness));
      d = softStart + softness * (-0.6 * u * u + 0.2 * u + 1.4) * u;
    }
    const cosA = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
    const cosB = Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2)));
    const alpha = Math.acos(cosA);
    const beta = Math.acos(cosB);
    const bs = resolveBendSign(c, U, L, config, bendHint);
    U.ang = clampAnatomicalAngle(U, (aim - bs * alpha - base1) / DEG, constrainLimits);
    L.ang = clampAnatomicalAngle(L, fx * (bs * ((Math.PI - beta) / DEG) - restDiff), constrainLimits);
  }
  solveRig(nodes, by, bondOn, wingPop);
}

export function solveFABRIKChain(
  chainIds: string[],
  targetWorld: [number, number],
  nodes: RigNode[],
  by: Record<string, RigNode>,
  bondOn: boolean,
  wingPop: number,
  config: IKConfig,
  constrainLimits: boolean,
  opts?: {
    poleBias?: [number, number];
    softDamp?: boolean;
    allowRootShift?: boolean;
    rootShiftWeight?: number;
    rootNode?: RigNode;
  },
): void {
  const chain: RigNode[] = [];
  for (const id of chainIds) {
    if (by[id]) chain.push(by[id]);
  }
  if (chain.length < 2) return;

  solveRig(nodes, by, bondOn, wingPop);
  const nCount = chain.length;
  const pts: Array<[number, number]> = chain.map((n) => pos(n, by));
  const lengths: number[] = [];
  let totalLen = 0;
  for (let i = 0; i < nCount - 1; i++) {
    const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) || 1;
    lengths.push(d);
    totalLen += d;
  }

  const rootOrigin: [number, number] = [pts[0][0], pts[0][1]];
  let effTarget: [number, number] = [targetWorld[0], targetWorld[1]];
  const toTx = effTarget[0] - rootOrigin[0];
  const toTy = effTarget[1] - rootOrigin[1];
  const rawDist = Math.hypot(toTx, toTy) || 1;

  if ((opts?.softDamp ?? true) && !config.allowStretch && config.softness > 0.001) {
    const hardMax = totalLen - 4;
    const softness = totalLen * Math.max(0, Math.min(0.28, config.softness));
    const softStart = hardMax - softness;
    if (rawDist > softStart && rawDist < softStart + 1.4 * softness) {
      const u = (rawDist - softStart) / (1.4 * softness);
      const dampedDist = softStart + softness * (-0.6 * u * u + 0.2 * u + 1.4) * u;
      effTarget = [
        rootOrigin[0] + (toTx / rawDist) * dampedDist,
        rootOrigin[1] + (toTy / rawDist) * dampedDist,
      ];
    }
  }

  if (opts?.poleBias && nCount >= 3) {
    const [pbx, pby] = opts.poleBias;
    for (let i = 1; i < nCount - 1; i++) {
      pts[i][0] += pbx * 64;
      pts[i][1] += pby * 64;
    }
  }

  const iters = Math.max(2, Math.min(32, Math.round(config.iterations)));
  const tol = Math.max(0.25, config.tolerance);
  const distTarget = Math.hypot(effTarget[0] - rootOrigin[0], effTarget[1] - rootOrigin[1]);

  if (!config.allowStretch && distTarget >= totalLen - 0.5 && !opts?.allowRootShift) {
    const ux = (effTarget[0] - rootOrigin[0]) / (distTarget || 1);
    const uy = (effTarget[1] - rootOrigin[1]) / (distTarget || 1);
    pts[0] = [rootOrigin[0], rootOrigin[1]];
    for (let i = 0; i < nCount - 1; i++) {
      pts[i + 1] = [pts[i][0] + ux * lengths[i], pts[i][1] + uy * lengths[i]];
    }
  } else {
    for (let iter = 0; iter < iters; iter++) {
      const endErr = Math.hypot(
        pts[nCount - 1][0] - effTarget[0],
        pts[nCount - 1][1] - effTarget[1],
      );
      if (endErr <= tol) break;

      pts[nCount - 1] = [effTarget[0], effTarget[1]];
      for (let i = nCount - 2; i >= 0; i--) {
        const dx = pts[i][0] - pts[i + 1][0];
        const dy = pts[i][1] - pts[i + 1][1];
        const d = Math.hypot(dx, dy) || 1;
        const r = lengths[i] / d;
        pts[i] = [pts[i + 1][0] + dx * r, pts[i + 1][1] + dy * r];
      }

      if (opts?.allowRootShift) {
        const w = opts.rootShiftWeight ?? 0.35;
        pts[0] = [
          rootOrigin[0] + (pts[0][0] - rootOrigin[0]) * w,
          rootOrigin[1] + (pts[0][1] - rootOrigin[1]) * w,
        ];
      } else {
        pts[0] = [rootOrigin[0], rootOrigin[1]];
      }

      for (let i = 0; i < nCount - 1; i++) {
        const dx = pts[i + 1][0] - pts[i][0];
        const dy = pts[i + 1][1] - pts[i][1];
        const d = Math.hypot(dx, dy) || 1;
        const r = lengths[i] / d;
        pts[i + 1] = [pts[i][0] + dx * r, pts[i][1] + dy * r];
      }
    }
  }

  const shiftTarget = opts?.rootNode ?? (chain[0] && !chain[0].parent ? chain[0] : null);
  if (opts?.allowRootShift && shiftTarget) {
    shiftTarget.tx += pts[0][0] - rootOrigin[0];
    shiftTarget.ty += pts[0][1] - rootOrigin[1];
    solveRig(nodes, by, bondOn, wingPop);
  }

  for (let i = 0; i < nCount - 1; i++) {
    const curr = chain[i];
    const next = chain[i + 1];
    if (curr.lock) continue;
    solveRig(nodes, by, bondOn, wingPop);
    const currWorld = pos(curr, by);
    const targetDir = Math.atan2(pts[i + 1][1] - currWorld[1], pts[i + 1][0] - currWorld[0]);
    setWorldDirExact(curr, next.piv, targetDir, by);
    if (constrainLimits) {
      curr.ang = clampAnatomicalAngle(curr, curr.ang, true);
    }
    curr.ang = clampRealisticShoulder(curr, curr.ang, by, wingPop > 0.05);
  }
  solveRig(nodes, by, bondOn, wingPop);
}

export function solveLimbChain(
  c: LimbChainDef,
  target: [number, number],
  nodes: RigNode[],
  by: Record<string, RigNode>,
  bondOn: boolean,
  wingPop: number,
  config: IKConfig,
  constrainLimits: boolean,
  bendHint = 0,
): void {
  const U = by[c.upper];
  const L = by[c.lower];
  const E = by[c.effector];
  if (!U || !L || !E) return;

  if (config.solver === 'analytical') {
    solveAnalyticalLimbIK(c, target, nodes, by, bondOn, wingPop, config, constrainLimits, bendHint);
    return;
  }

  solveRig(nodes, by, bondOn, wingPop);
  const pRoot = pos(U, by);
  const vx = target[0] - pRoot[0];
  const vy = target[1] - pRoot[1];
  const dist = Math.hypot(vx, vy) || 1;
  const perpX = vy / dist;
  const perpY = -vx / dist;
  const bs = resolveBendSign(c, U, L, config, bendHint);
  const par = parentOf(U, by);
  const pDet = par ? par.w[0] * par.w[3] - par.w[1] * par.w[2] : 1;
  const flipMul = (U.flipX ? -1 : 1) * (pDet < 0 ? -1 : 1);
  const pole: [number, number] = [perpX * bs * flipMul, perpY * bs * flipMul];

  solveFABRIKChain(
    [c.upper, c.lower, c.effector],
    target,
    nodes,
    by,
    bondOn,
    wingPop,
    config,
    constrainLimits,
    { poleBias: pole, softDamp: true },
  );
}

export interface FootContactInfo {
  ankle: [number, number];
  heel: [number, number];
  ball: [number, number];
  toe: [number, number];
  maxY: number;
  midX: number;
  minX: number;
  maxX: number;
  soleRad: number;
  soleSpan: number;
}

export function footContactInfo(f: RigNode, by: Record<string, RigNode>): FootContactInfo {
  const isLeft = f.id === 'footL';
  const ankle = pos(f, by);
  const heelLocal: [number, number] = isLeft ? [1590, 7252] : [902, 7252];
  const ballLocal: [number, number] = isLeft ? [2050, 7485] : [442, 7485];
  const toeNode = by[isLeft ? 'toeL' : 'toeR'];
  const toeLocal: [number, number] = toeNode
    ? toeNode.piv
    : isLeft
    ? [2296, 7593]
    : [192, 7593];

  const heel = transformLocalPt(f, heelLocal[0], heelLocal[1]);
  const ball = transformLocalPt(f, ballLocal[0], ballLocal[1]);
  const toe = transformLocalPt(f, toeLocal[0], toeLocal[1]);

  return {
    ankle,
    heel,
    ball,
    toe,
    maxY: Math.max(heel[1], ball[1], toe[1]),
    midX: ball[0] * 0.5 + heel[0] * 0.25 + toe[0] * 0.25,
    minX: Math.min(heel[0], toe[0]),
    maxX: Math.max(heel[0], toe[0]),
    soleRad: Math.atan2(toe[1] - heel[1], toe[0] - heel[0]),
    soleSpan: Math.hypot(toe[0] - heel[0], toe[1] - heel[1]),
  };
}

export interface HandContactInfo {
  wrist: [number, number];
  palm: [number, number];
  tip: [number, number];
  maxY: number;
  midX: number;
  palmRad: number;
}

export function handContactInfo(h: RigNode, by: Record<string, RigNode>): HandContactInfo {
  const isLeft = h.id === 'handL';
  const wrist = pos(h, by);
  const palmLocal: [number, number] = isLeft ? [1995, 4220] : [505, 4276];
  const tipNode = by[isLeft ? 'fingerTipL' : 'fingerTipR'];
  const tipLocal: [number, number] = tipNode
    ? tipNode.piv
    : isLeft
    ? [2012, 4697]
    : [492, 4697];

  const palm = transformLocalPt(h, palmLocal[0], palmLocal[1]);
  const tip = transformLocalPt(h, tipLocal[0], tipLocal[1]);

  return {
    wrist,
    palm,
    tip,
    maxY: Math.max(wrist[1], palm[1], tip[1]),
    midX: palm[0] * 0.6 + tip[0] * 0.4,
    palmRad: Math.atan2(tip[1] - wrist[1], tip[0] - wrist[0]),
  };
}

export function alignFootSoleToSlope(
  f: RigNode,
  by: Record<string, RigNode>,
  targetSlopeRad: number,
  blend: number,
  constrainLimits: boolean,
): void {
  const sole = footContactInfo(f, by);
  const dRight = Math.atan2(
    Math.sin(targetSlopeRad - sole.soleRad),
    Math.cos(targetSlopeRad - sole.soleRad),
  );
  const dLeft = Math.atan2(
    Math.sin(targetSlopeRad + Math.PI - sole.soleRad),
    Math.cos(targetSlopeRad + Math.PI - sole.soleRad),
  );
  const deltaDeg = (Math.abs(dRight) <= Math.abs(dLeft) ? dRight : dLeft) / DEG;
  f.ang = clampAnatomicalAngle(f, f.ang + deltaDeg * blend, constrainLimits);
}

export function alignHandPalmToSlope(
  h: RigNode,
  by: Record<string, RigNode>,
  targetSlopeRad: number,
  blend: number,
  constrainLimits: boolean,
): void {
  const info = handContactInfo(h, by);
  const dRight = Math.atan2(
    Math.sin(targetSlopeRad - info.palmRad),
    Math.cos(targetSlopeRad - info.palmRad),
  );
  const dLeft = Math.atan2(
    Math.sin(targetSlopeRad + Math.PI - info.palmRad),
    Math.cos(targetSlopeRad + Math.PI - info.palmRad),
  );
  const deltaDeg = (Math.abs(dRight) <= Math.abs(dLeft) ? dRight : dLeft) / DEG;
  h.ang = clampAnatomicalAngle(h, h.ang + deltaDeg * blend, constrainLimits);
}

export function figureLowestFootY(
  by: Record<string, RigNode>,
  groundY = DEFAULT_GROUND_Y,
  vpX = 1257,
  tiltDownDeg = 0,
): { maxPenetration: number; lowestY: number } {
  let maxPen = -1e9;
  let lowestY = -1e9;
  for (const id of ['footL', 'footR'] as const) {
    const f = by[id];
    if (!f) continue;
    const sole = footContactInfo(f, by);
    const floorHere = groundYAt(sole.midX, groundY, vpX, tiltDownDeg);
    maxPen = Math.max(maxPen, sole.maxY - floorHere);
    lowestY = Math.max(lowestY, sole.maxY);
  }
  return { maxPenetration: maxPen, lowestY };
}

export function enforceGroundContact(
  nodes: RigNode[],
  by: Record<string, RigNode>,
  root: RigNode,
  bondOn: boolean,
  wingPop: number,
  groundY: number,
  pullDownToo = false,
  vpX = 1257,
  tiltDownDeg = 0,
): boolean {
  solveRig(nodes, by, bondOn, wingPop);
  const { maxPenetration } = figureLowestFootY(by, groundY, vpX, tiltDownDeg);
  if (maxPenetration < -1e8) return false;
  const diff = -maxPenetration;
  if (diff < -0.5 || (pullDownToo && diff > 0.5)) {
    root.ty += diff;
    solveRig(nodes, by, bondOn, wingPop);
    return true;
  }
  return false;
}

/**
 * Sequence-level advanced physics for 2 real feet against a depth-tilted ground plane,
 * plus hand wrist momentum, palm-to-floor collision, and effector ground pinning.
 */
export function applyClipAdvancedPhysics(
  frames: RetargetFrameResult[],
  hasLegsPerFrame: boolean[],
  nodes: RigNode[],
  by: Record<string, RigNode>,
  root: RigNode,
  options: RetargetOptions,
  vpX: number,
  computeCoM: (byMap: Record<string, RigNode>) => CoMPoint,
): RetargetFrameResult[] {
  const n = frames.length;
  if (!n || (!options.advancedPhysics && !options.handGroundPhysics && !options.groundLock)) {
    return frames;
  }

  const out: RetargetFrameResult[] = frames.map((f) => ({
    ...f,
    pose: { ...f.pose },
    root: [f.root[0], f.root[1]],
    com: { ...f.com },
    clampedNodes: [...f.clampedNodes],
    bondStrain: f.bondStrain.map((b) => ({ ...b })),
  }));

  const tiltDeg = options.floorTiltDeg ?? 0;
  const slopeRad = tiltDeg * DEG;
  const ikCfg: IKConfig = {
    ...DEFAULT_IK_CONFIG,
    solver: options.solverMode === 'ik-analytical' ? 'analytical' : 'fabrik',
    groundY: options.groundY,
  };

  const applyFrameToRig = (res: RetargetFrameResult) => {
    for (const node of nodes) {
      node.ang = res.pose[node.id] ?? 0;
    }
    root.tx = res.root[0];
    root.ty = res.root[1];
    solveRig(nodes, by, options.bondOn, 0);
  };

  const snapshotRigToFrame = (idx: number) => {
    const pose: Record<string, number> = {};
    const clampedNodes: string[] = [];
    for (const node of nodes) {
      pose[node.id] = Math.round(node.ang * 100) / 100;
      const t = getTensionRatio(node);
      if (t.atLimit || t.nearLimit) clampedNodes.push(node.id);
    }
    out[idx] = {
      pose,
      root: [Math.round(root.tx * 10) / 10, Math.round(root.ty * 10) / 10],
      bondStrain: getBondStatus(nodes, options.bondOn),
      clampedNodes,
      subjectConfidence: frames[idx].subjectConfidence,
      com: computeCoM(by),
    };
  };

  // Pass 1: Wrist secondary momentum & gentle gravity settle on multi-frame clips
  if (options.advancedPhysics && n >= 2) {
    for (let i = 0; i < n; i++) {
      const prev = frames[(i - 1 + n) % n];
      const curr = out[i];
      for (const side of ['L', 'R'] as const) {
        const foreId = 'forearm' + side;
        const handId = 'hand' + side;
        const handNode = by[handId];
        if (!handNode) continue;
        const dFore = normalizeDeg((curr.pose[foreId] ?? 0) - (prev.pose[foreId] ?? 0));
        const wristLag = Math.max(-18, Math.min(18, -dFore * 0.24));
        const nextHand = curr.pose[handId] ?? 0;
        curr.pose[handId] = clampAnatomicalAngle(handNode, nextHand + wristLag, options.constrainLimits);
      }
    }
  }

  // Persistent floor stance anchors for anti-skate ground pinning
  let footAnchor: Record<'footL' | 'footR', { x: number; y: number; active: boolean }> = {
    footL: { x: 0, y: options.groundY, active: false },
    footR: { x: 0, y: options.groundY, active: false },
  };
  let handAnchor: Record<'handL' | 'handR', { x: number; y: number; active: boolean }> = {
    handL: { x: 0, y: options.groundY, active: false },
    handR: { x: 0, y: options.groundY, active: false },
  };

  const depthSpan = Math.max(0, Math.min(1, options.depthEmulation ?? 0.55)) * 185;
  const pinGrip = Math.max(0, Math.min(1, options.groundPinStrength ?? 0.75));
  const anyExplicitPin =
    options.pinnedEffectors.footL ||
    options.pinnedEffectors.footR ||
    options.pinnedEffectors.handL ||
    options.pinnedEffectors.handR;

  for (let i = 0; i < n; i++) {
    const hasLegs = hasLegsPerFrame[i] ?? true;
    applyFrameToRig(out[i]);

    // Skip dynamic foot grounding on tight portrait/head crops unless feet are explicitly pinned
    const runFeetPhysics = hasLegs || options.pinnedEffectors.footL || options.pinnedEffectors.footR;

    if (runFeetPhysics && (options.groundLock || options.advancedPhysics || options.pinnedEffectors.footL || options.pinnedEffectors.footR)) {
      const footL = by.footL;
      const footR = by.footR;
      const pelvis = by.pelvis;
      if (footL && footR && pelvis) {
        const infoL = footContactInfo(footL, by);
        const infoR = footContactInfo(footR, by);
        const pelvisPos = pos(pelvis, by);

        // Emulate 2.5D depth by tilting the nearer stance foot down below the baseline ground line
        const baseFloorL = groundYAt(infoL.midX, options.groundY, vpX, tiltDeg);
        const baseFloorR = groundYAt(infoR.midX, options.groundY, vpX, tiltDeg);
        const penL = infoL.maxY - baseFloorL;
        const penR = infoR.maxY - baseFloorR;

        // Higher screen Y / forward leg steps slightly deeper into foreground lane below ground line
        const depthBiasL = penL >= penR ? depthSpan * 0.72 : -depthSpan * 0.18;
        const depthBiasR = penR > penL ? depthSpan * 0.72 : -depthSpan * 0.18;
        const targetFloorL = baseFloorL + depthBiasL;
        const targetFloorR = baseFloorR + depthBiasR;

        const lowestDelta = Math.max(infoL.maxY - targetFloorL, infoR.maxY - targetFloorR);
        if (options.groundLock && (lowestDelta > 0.5 || lowestDelta < -0.5)) {
          root.ty -= lowestDelta;
          solveRig(nodes, by, options.bondOn, 0);
        }

        const settledL = footContactInfo(footL, by);
        const settledR = footContactInfo(footR, by);
        const gapL = targetFloorL - settledL.maxY;
        const gapR = targetFloorR - settledR.maxY;
        const stanceTol = 230;

        const isStanceL =
          options.pinnedEffectors.footL ||
          (gapL <= stanceTol && (gapL <= gapR + 40 || gapL < 95));
        const isStanceR =
          options.pinnedEffectors.footR ||
          (gapR <= stanceTol && (gapR <= gapL + 40 || gapR < 95));

        const processFoot = (
          side: 'L' | 'R',
          footNode: RigNode,
          chainIdx: number,
          info: FootContactInfo,
          floorY: number,
          inStance: boolean,
          explicitPin: boolean,
        ) => {
          const fid = side === 'L' ? 'footL' : 'footR';
          if (!inStance && !explicitPin) {
            footAnchor[fid].active = false;
            // Even swing feet never penetrate below the floor plane
            if (info.maxY > floorY) {
              const lift = info.maxY - floorY;
              const targetAnkle: [number, number] = [info.ankle[0], info.ankle[1] - lift];
              solveLimbChain(LIMB_CHAINS[chainIdx], targetAnkle, nodes, by, options.bondOn, 0, ikCfg, options.constrainLimits);
            }
            return;
          }

          if (!footAnchor[fid].active) {
            footAnchor[fid] = { x: info.midX, y: floorY, active: true };
          } else {
            const lerpRate = explicitPin ? 0.04 : 1 - pinGrip * 0.86;
            footAnchor[fid].x = footAnchor[fid].x + (info.midX - footAnchor[fid].x) * lerpRate;
            footAnchor[fid].y = floorY;
          }

          // Re-solve leg chain so sole settles cleanly at pinned (anchorX, floorY)
          if (options.advancedPhysics || explicitPin) {
            const ankleBelowSoleOffset = info.maxY - info.ankle[1];
            const grip = explicitPin ? 1.0 : pinGrip * 0.85;
            const pinnedMidX = info.midX + (footAnchor[fid].x - info.midX) * grip;
            const shiftX = pinnedMidX - info.midX;
            const desiredAnkle: [number, number] = [
              info.ankle[0] + shiftX,
              floorY - ankleBelowSoleOffset,
            ];
            solveLimbChain(
              LIMB_CHAINS[chainIdx],
              desiredAnkle,
              nodes,
              by,
              options.bondOn,
              0,
              ikCfg,
              options.constrainLimits,
            );

            // Real 2-foot heel-strike -> flat plant -> toe-off roll against floor slope
            const leadOffset = info.midX - pelvisPos[0];
            let rollDeg = 0;
            if (!explicitPin && Math.abs(leadOffset) > 180) {
              // Leading foot tilts toes slightly up for heel-strike; trailing lifts heel slightly
              rollDeg = leadOffset > 0 ? 5.5 : -9.5;
            }
            alignFootSoleToSlope(footNode, by, slopeRad + rollDeg * DEG, 0.88, options.constrainLimits);
            solveRig(nodes, by, options.bondOn, 0);

            // Final anti-penetration clamp if sole rotation dipped heel or toe below floorY
            const postSole = footContactInfo(footNode, by);
            const postPen = postSole.maxY - floorY;
            if (postPen > 2) {
              const correctedAnkle: [number, number] = [
                postSole.ankle[0],
                postSole.ankle[1] - postPen,
              ];
              solveLimbChain(
                LIMB_CHAINS[chainIdx],
                correctedAnkle,
                nodes,
                by,
                options.bondOn,
                0,
                ikCfg,
                options.constrainLimits,
              );
            }
          }
        };

        processFoot('L', footL, 2, settledL, targetFloorL, isStanceL, options.pinnedEffectors.footL);
        processFoot('R', footR, 3, settledR, targetFloorR, isStanceR, options.pinnedEffectors.footR);
      }
    }

    // Hand Ground Physics: Palm collision, flat floor brace & optional hand pinning
    if (options.handGroundPhysics || options.pinnedEffectors.handL || options.pinnedEffectors.handR) {
      for (const side of ['L', 'R'] as const) {
        const hid = side === 'L' ? 'handL' : 'handR';
        const chainIdx = side === 'L' ? 0 : 1;
        const handNode = by[hid];
        if (!handNode) continue;
        const info = handContactInfo(handNode, by);
        const floorY = groundYAt(info.midX, options.groundY, vpX, tiltDeg);
        const explicitPin = options.pinnedEffectors[hid];

        if (explicitPin) {
          if (!handAnchor[hid].active) {
            handAnchor[hid] = { x: info.midX, y: floorY, active: true };
          }
          const palmOffset = info.maxY - info.wrist[1];
          const targetWrist: [number, number] = [
            handAnchor[hid].x - (info.midX - info.wrist[0]),
            floorY - Math.min(palmOffset, 420),
          ];
          solveLimbChain(
            LIMB_CHAINS[chainIdx],
            targetWrist,
            nodes,
            by,
            options.bondOn,
            0,
            ikCfg,
            options.constrainLimits,
          );
          alignHandPalmToSlope(handNode, by, slopeRad, 0.72, options.constrainLimits);
          solveRig(nodes, by, options.bondOn, 0);
        } else {
          handAnchor[hid].active = false;
          // Prevent hands from penetrating below the ground surface; flatten palm smoothly on contact
          if (info.maxY > floorY - 8) {
            const pen = info.maxY - floorY;
            if (pen > 0) {
              const targetWrist: [number, number] = [info.wrist[0], info.wrist[1] - pen];
              solveLimbChain(
                LIMB_CHAINS[chainIdx],
                targetWrist,
                nodes,
                by,
                options.bondOn,
                0,
                ikCfg,
                options.constrainLimits,
              );
            }
            alignHandPalmToSlope(handNode, by, slopeRad, 0.65, options.constrainLimits);
            solveRig(nodes, by, options.bondOn, 0);
          }
        }
      }
    }

    if (anyExplicitPin || options.advancedPhysics || options.handGroundPhysics || options.groundLock) {
      snapshotRigToFrame(i);
    }
  }

  return out;
}

export function skelFocalX(by: Record<string, RigNode>, root?: RigNode): number {
  return root ? pos(root, by)[0] : 1257;
}

export function hitPerspHandle(
  q: [number, number],
  persp: PerspectiveState,
  cam: { z: number; ox: number; oy: number; dpr: number },
): PerspHandle {
  if (!persp.enabled) return null;
  const tol = (12 * cam.dpr) / Math.max(0.001, cam.z);
  const sx = q[0] * cam.z + cam.ox;
  const sy = q[1] * cam.z + cam.oy;
  const vpx = persp.vpX * cam.z + cam.ox;
  const vpy = persp.horizonY * cam.z + cam.oy;
  if (Math.hypot(sx - vpx, sy - vpy) <= 13 * cam.dpr) return 'vp';

  const [tx, ty] = getGroundTiltHandlePos(persp);
  const tsx = tx * cam.z + cam.ox;
  const tsy = ty * cam.z + cam.oy;
  if (Math.hypot(sx - tsx, sy - tsy) <= 13 * cam.dpr) return 'tilt';

  if (Math.abs(q[1] - persp.horizonY) <= tol) return 'horizon';
  const gyHere = groundYAt(q[0], persp.groundY, persp.vpX, persp.tiltDownDeg);
  if (Math.abs(q[1] - gyHere) <= tol * 1.15) return 'ground';
  return null;
}

export function syncPinsFromRig(
  nodes: RigNode[],
  by: Record<string, RigNode>,
  bondOn: boolean,
  prevPins: Record<string, IKPinEntry>,
): Record<string, IKPinEntry> {
  solveRig(nodes, by, bondOn, 0);
  const next: Record<string, IKPinEntry> = {};
  for (const id of EFFECTOR_IDS) {
    const n = by[id];
    if (!n) continue;
    const tipNode =
      id === 'footL'
        ? by.toeL
        : id === 'footR'
        ? by.toeR
        : id === 'handL'
        ? by.fingerTipL
        : id === 'handR'
        ? by.fingerTipR
        : by.chinTip;
    next[id] = {
      pos: pos(n, by),
      endDir: getWorldDir(n, tipNode ? tipNode.piv : null, by),
      pinned: prevPins[id]?.pinned ?? false,
    };
  }
  return next;
}

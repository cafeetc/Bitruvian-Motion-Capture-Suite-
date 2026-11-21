import { clampAnatomicalAngle, getBondStatus, getTensionRatio, normalizeDeg, solveRig } from './fkEngine';
import { computeSegmentalCoM } from './mocapRetargeter';
import type { LoopLearnerState, RetargetFrameResult, RetargetOptions, RigNode } from './types';

const SHOULDER_AND_CORE_NODES = new Set([
  'swivelL',
  'swivelR',
  'acromionL',
  'acromionR',
  'braceL',
  'braceR',
  'ribL',
  'ribR',
  'neck',
  'thorax',
  'lumbar',
]);

export function createLoopLearnerState(baseFrames: RetargetFrameResult[]): LoopLearnerState {
  const cloned = baseFrames.map((f) => ({
    ...f,
    pose: { ...f.pose },
    root: [f.root[0], f.root[1]] as [number, number],
    com: { ...f.com },
    clampedNodes: [...f.clampedNodes],
    bondStrain: f.bondStrain.map((b) => ({ ...b })),
  }));
  return {
    loopPass: 0,
    baseFrames: cloned,
    refinedFrames: cloned.map((f) => ({
      ...f,
      pose: { ...f.pose },
      root: [f.root[0], f.root[1]] as [number, number],
      com: { ...f.com },
    })),
    frameDeltas: baseFrames.map(() => ({})),
    rootDeltas: baseFrames.map(() => [0, 0]),
    postureBias: {},
    editedFrameCount: 0,
  };
}

function circularIndex(idx: number, n: number): number {
  return ((idx % n) + n) % n;
}

function applyCorrectionsAndRecompute(
  state: LoopLearnerState,
  nodes: RigNode[],
  by: Record<string, RigNode>,
  root: RigNode,
  options: RetargetOptions,
  targetFrames?: Set<number>,
): RetargetFrameResult[] {
  const n = state.baseFrames.length;
  if (!n) return [];

  return state.refinedFrames.map((curr, idx) => {
    if (targetFrames && !targetFrames.has(idx)) {
      return curr;
    }
    const base = state.baseFrames[idx];
    const delta = state.frameDeltas[idx] ?? {};
    const rDelta = state.rootDeltas[idx] ?? [0, 0];

    const pose: Record<string, number> = {};
    const clampedNodes: string[] = [];

    for (const node of nodes) {
      const id = node.id;
      const baseAng = base.pose[id] ?? 0;
      const bias = state.postureBias[id] ?? 0;
      const localDelta = delta[id] ?? 0;
      const nextAng = clampAnatomicalAngle(node, baseAng + bias + localDelta, options.constrainLimits);
      node.ang = nextAng;
      pose[id] = Math.round(nextAng * 100) / 100;
      const t = getTensionRatio(node);
      if (t.atLimit || t.nearLimit) clampedNodes.push(id);
    }

    root.tx = Math.round((base.root[0] + rDelta[0]) * 10) / 10;
    root.ty = Math.round((base.root[1] + rDelta[1]) * 10) / 10;
    solveRig(nodes, by, options.bondOn, 0);

    return {
      pose,
      root: [root.tx, root.ty],
      bondStrain: getBondStatus(nodes, options.bondOn),
      clampedNodes,
      subjectConfidence: base.subjectConfidence,
      com: computeSegmentalCoM(by),
    };
  });
}

/**
 * Records a user live-pose correction while playback is moving, distributing a
 * raised-cosine cyclic kernel around `frameIdx` so changes glide smoothly into the loop.
 */
export function recordLivePoseEdit(
  state: LoopLearnerState,
  frameIdx: number,
  activeNodeIds: string[],
  desiredPose: Record<string, number>,
  desiredRoot: [number, number] | null,
  nodes: RigNode[],
  by: Record<string, RigNode>,
  root: RigNode,
  options: RetargetOptions,
  learnBias = true,
): LoopLearnerState {
  const n = state.baseFrames.length;
  if (!n || activeNodeIds.length === 0) return state;

  const center = circularIndex(frameIdx, n);
  const currentFrame = state.refinedFrames[center] ?? state.baseFrames[center];
  if (!currentFrame) return state;

  const radius = Math.max(1, Math.min(5, Math.floor(n / 4)));
  const frameDeltas = state.frameDeltas.map((d) => ({ ...d }));
  const rootDeltas = state.rootDeltas.map((r) => [r[0], r[1]] as [number, number]);
  const postureBias = { ...state.postureBias };
  const touchedFrames = new Set<number>();

  for (const id of activeNodeIds) {
    if (!(id in desiredPose)) continue;
    const baseVal = state.baseFrames[center].pose[id] ?? 0;
    const biasVal = postureBias[id] ?? 0;
    const targetDelta = normalizeDeg(desiredPose[id] - (baseVal + biasVal));
    const prevDelta = frameDeltas[center][id] ?? 0;
    const stepDiff = normalizeDeg(targetDelta - prevDelta);

    if (Math.abs(stepDiff) < 0.05) continue;

    // Subtle persistent posture bias learning when user consistently adjusts a joint
    if (learnBias) {
      const biasStep = Math.max(-1.2, Math.min(1.2, stepDiff * 0.08));
      postureBias[id] = Math.max(-28, Math.min(28, biasVal + biasStep));
    }

    for (let offset = -radius; offset <= radius; offset++) {
      const fi = circularIndex(center + offset, n);
      const w = 0.5 * (1 + Math.cos((Math.PI * offset) / (radius + 1)));
      const existing = frameDeltas[fi][id] ?? 0;
      frameDeltas[fi][id] = normalizeDeg(existing + stepDiff * w);
      touchedFrames.add(fi);
    }
  }

  if (desiredRoot && activeNodeIds.includes('pelvis')) {
    const baseRoot = state.baseFrames[center].root;
    const dx = desiredRoot[0] - baseRoot[0] - (rootDeltas[center][0] ?? 0);
    const dy = desiredRoot[1] - baseRoot[1] - (rootDeltas[center][1] ?? 0);
    if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
      for (let offset = -radius; offset <= radius; offset++) {
        const fi = circularIndex(center + offset, n);
        const w = 0.5 * (1 + Math.cos((Math.PI * offset) / (radius + 1)));
        rootDeltas[fi][0] += dx * w;
        rootDeltas[fi][1] += dy * w;
        touchedFrames.add(fi);
      }
    }
  }

  if (touchedFrames.size === 0) return state;

  const nextState: LoopLearnerState = {
    ...state,
    frameDeltas,
    rootDeltas,
    postureBias,
    editedFrameCount: frameDeltas.filter((d) => Object.keys(d).length > 0).length,
  };

  nextState.refinedFrames = applyCorrectionsAndRecompute(
    nextState,
    nodes,
    by,
    root,
    options,
    touchedFrames,
  );
  return nextState;
}

/**
 * Runs one cyclic cleanup pass when the motion loop completes a cycle:
 * - Suppresses single-frame shoulder & torso tremor (Lotte Reiniger cutout poise)
 * - Blends cyclic seam discontinuity between frame N-1 and frame 0
 * - Converges smoothly over passes 1..8 without washing out genuine limb arcs
 */
export function advanceLoopCleanupPass(
  state: LoopLearnerState,
  nodes: RigNode[],
  by: Record<string, RigNode>,
  root: RigNode,
  options: RetargetOptions,
): LoopLearnerState {
  const n = state.refinedFrames.length;
  if (n < 4) return state;

  const nextPass = state.loopPass + 1;
  // Converge automatically across early passes so loops never over-flatten into stillness
  if (nextPass > 8) {
    return { ...state, loopPass: nextPass };
  }

  const prevFrames = state.refinedFrames;
  const passDecay = Math.pow(0.76, nextPass - 1);
  const poise = Math.max(0, Math.min(1, options.shoulderPoise));
  const weights = [0.1, 0.22, 0.36, 0.22, 0.1];

  const nextFrames: RetargetFrameResult[] = prevFrames.map((frame, i) => {
    const isCore = (id: string) => SHOULDER_AND_CORE_NODES.has(id);
    const nextPose: Record<string, number> = {};
    const clampedNodes: string[] = [];

    for (const node of nodes) {
      const id = node.id;
      const cur = frame.pose[id] ?? 0;

      // Circular 5-tap neighbor average
      let avg = 0;
      for (let k = -2; k <= 2; k++) {
        const fi = circularIndex(i + k, n);
        avg += (prevFrames[fi].pose[id] ?? 0) * weights[k + 2];
      }

      // Detect high-frequency spike outlier
      const pPrev = prevFrames[circularIndex(i - 1, n)].pose[id] ?? cur;
      const pNext = prevFrames[circularIndex(i + 1, n)].pose[id] ?? cur;
      const mid = (pPrev + pNext) * 0.5;
      const dev = Math.abs(cur - mid);

      let blend = isCore(id)
        ? (0.28 + poise * 0.36) * passDecay
        : 0.18 * passDecay;

      if (dev > (isCore(id) ? 6 : 16)) {
        blend = Math.min(0.75, blend + 0.35);
      }

      // Preserve amplitude relative to base + user edit so deliberate arcs remain crisp
      const rawTarget = cur + (avg - cur) * blend;
      const baseTarget = (state.baseFrames[i].pose[id] ?? 0) + (state.postureBias[id] ?? 0) + (state.frameDeltas[i]?.[id] ?? 0);
      const maxDrift = isCore(id) ? 10 : 6;
      const bounded = Math.max(baseTarget - maxDrift, Math.min(baseTarget + maxDrift, rawTarget));

      node.ang = clampAnatomicalAngle(node, bounded, options.constrainLimits);
      nextPose[id] = Math.round(node.ang * 100) / 100;
      const t = getTensionRatio(node);
      if (t.atLimit || t.nearLimit) clampedNodes.push(id);
    }

    // Cyclic seam & root translation low-pass smoothing
    let rx = 0;
    let ry = 0;
    for (let k = -2; k <= 2; k++) {
      const fi = circularIndex(i + k, n);
      rx += prevFrames[fi].root[0] * weights[k + 2];
      ry += prevFrames[fi].root[1] * weights[k + 2];
    }
    const rootBlend = 0.25 * passDecay;
    root.tx = Math.round((frame.root[0] + (rx - frame.root[0]) * rootBlend) * 10) / 10;
    root.ty = Math.round((frame.root[1] + (ry - frame.root[1]) * rootBlend) * 10) / 10;

    solveRig(nodes, by, options.bondOn, 0);

    return {
      pose: nextPose,
      root: [root.tx, root.ty],
      bondStrain: getBondStatus(nodes, options.bondOn),
      clampedNodes,
      subjectConfidence: frame.subjectConfidence,
      com: computeSegmentalCoM(by),
    };
  });

  return {
    ...state,
    loopPass: nextPass,
    refinedFrames: nextFrames,
  };
}

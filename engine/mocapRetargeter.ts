import type { KeypointName, Keypoints, Person, Point } from '../types';
import {
  DEG,
  clampAnatomicalAngle,
  clampRealisticShoulder,
  getBondStatus,
  getTensionRatio,
  normalizeDeg,
  pos,
  solveRig,
  worldToLocalAngle,
} from './fkEngine';
import {
  DEFAULT_IK_CONFIG,
  alignFootSoleToSlope,
  enforceGroundContact,
  setWorldDirExact,
  solveLimbChain,
} from './ikEngine';
import { LIMB_CHAINS } from './rigMetadata';
import type { IKConfig, RetargetFrameResult, RetargetOptions, RigNode, SubjectFraming } from './types';

export function hasLegLandmarks(person: Person | null | undefined): boolean {
  if (!person) return false;
  const kp = person.keypoints;
  return Boolean(kp.left_knee || kp.right_knee || kp.left_ankle || kp.right_ankle);
}

const KEYPOINT_NAMES: KeypointName[] = [
  'nose',
  'left_eye',
  'right_eye',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
];

function cloneKeypoints(kp: Keypoints): Keypoints {
  const out = {} as Keypoints;
  for (const name of KEYPOINT_NAMES) {
    const p = kp[name];
    out[name] = p ? { x: p.x, y: p.y } : null;
  }
  return out;
}

/**
 * Applies bidirectional exponential / Gaussian temporal smoothing across COCO frames
 * while preserving missing keypoints.
 */
export function smoothMocapFrames(frames: Person[][], smoothing: number): Person[][] {
  if (!frames.length || smoothing <= 0.01) return frames;
  const alpha = Math.max(0.12, 1 - smoothing * 0.85);
  const shoulderAlpha = Math.max(0.06, alpha * 0.38);

  const result: Person[][] = frames.map((frame) =>
    frame.map((p) => ({ keypoints: cloneKeypoints(p.keypoints) })),
  );

  // Forward pass on primary subject (index 0), with heavier damping on shoulder girdle
  for (let i = 1; i < result.length; i++) {
    const prev = result[i - 1]?.[0]?.keypoints;
    const curr = result[i]?.[0]?.keypoints;
    if (!prev || !curr) continue;
    for (const k of KEYPOINT_NAMES) {
      const a = prev[k];
      const b = curr[k];
      if (a && b) {
        const w = k === 'left_shoulder' || k === 'right_shoulder' ? shoulderAlpha : alpha;
        curr[k] = {
          x: a.x * (1 - w) + b.x * w,
          y: a.y * (1 - w) + b.y * w,
        };
      }
    }
  }

  // Backward pass for zero-phase smoothing
  for (let i = result.length - 2; i >= 0; i--) {
    const next = result[i + 1]?.[0]?.keypoints;
    const curr = result[i]?.[0]?.keypoints;
    if (!next || !curr) continue;
    for (const k of KEYPOINT_NAMES) {
      const a = next[k];
      const b = curr[k];
      if (a && b) {
        const backW = k === 'left_shoulder' || k === 'right_shoulder' ? 0.48 : 0.35;
        curr[k] = {
          x: b.x * (1 - backW) + a.x * backW,
          y: b.y * (1 - backW) + a.y * backW,
        };
      }
    }
  }

  return result;
}

function mirrorOrNormalizePoint(p: Point, mirror: boolean): Point {
  if (!p) return null;
  return mirror ? { x: 1 - p.x, y: p.y } : p;
}

export function normalizePersonKeypoints(person: Person, mirrorHorizontal: boolean): Keypoints {
  const kp = person.keypoints;
  if (!mirrorHorizontal) return cloneKeypoints(kp);

  return {
    nose: mirrorOrNormalizePoint(kp.nose, true),
    left_eye: mirrorOrNormalizePoint(kp.right_eye, true),
    right_eye: mirrorOrNormalizePoint(kp.left_eye, true),
    left_ear: mirrorOrNormalizePoint(kp.right_ear, true),
    right_ear: mirrorOrNormalizePoint(kp.left_ear, true),
    left_shoulder: mirrorOrNormalizePoint(kp.right_shoulder, true),
    right_shoulder: mirrorOrNormalizePoint(kp.left_shoulder, true),
    left_elbow: mirrorOrNormalizePoint(kp.right_elbow, true),
    right_elbow: mirrorOrNormalizePoint(kp.left_elbow, true),
    left_wrist: mirrorOrNormalizePoint(kp.right_wrist, true),
    right_wrist: mirrorOrNormalizePoint(kp.left_wrist, true),
    left_hip: mirrorOrNormalizePoint(kp.right_hip, true),
    right_hip: mirrorOrNormalizePoint(kp.left_hip, true),
    left_knee: mirrorOrNormalizePoint(kp.right_knee, true),
    right_knee: mirrorOrNormalizePoint(kp.left_knee, true),
    left_ankle: mirrorOrNormalizePoint(kp.right_ankle, true),
    right_ankle: mirrorOrNormalizePoint(kp.left_ankle, true),
  };
}

function midpoint(a: Point, b: Point): { x: number; y: number } | null {
  if (a && b) return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
  if (a) return { x: a.x, y: a.y };
  if (b) return { x: b.x, y: b.y };
  return null;
}

function dist2D(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function angle2D(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/**
 * Scores multiple detected people and selects the single clearest primary subject
 * (prioritizing visible landmark coverage, bounding size, and center composition).
 */
export function pickPrimarySubject(people: Person[] | null | undefined): Person | null {
  if (!people || people.length === 0) return null;
  if (people.length === 1) return people[0];

  let best: Person = people[0];
  let bestScore = -Infinity;

  for (const person of people) {
    const pts = KEYPOINT_NAMES.map((k) => person.keypoints[k]).filter(
      (p): p is { x: number; y: number } => Boolean(p),
    );
    if (pts.length === 0) continue;

    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    const area = Math.max(0.01, (maxX - minX) * (maxY - minY));
    const centerDist = Math.hypot(cx - 0.5, cy - 0.45);
    const hasCore =
      (person.keypoints.nose ? 1 : 0) +
      (person.keypoints.left_shoulder ? 1 : 0) +
      (person.keypoints.right_shoulder ? 1 : 0);

    const score = pts.length * 4 + hasCore * 5 + area * 18 - centerDist * 10;
    if (score > bestScore) {
      bestScore = score;
      best = person;
    }
  }

  return best;
}

/**
 * Classifies shot framing across full figures, upper-body crops, bust portraits, and head close-ups
 * so the stage camera can automatically zoom to match the subject's crop.
 */
export function classifySubjectFraming(frames: Person[][]): SubjectFraming {
  let hasLegs = 0;
  let hasHipsOrWrists = 0;
  let hasShoulders = 0;
  let hasHeadOnly = 0;

  for (const frame of frames) {
    const p = pickPrimarySubject(frame);
    if (!p) continue;
    const kp = p.keypoints;
    if (kp.left_ankle || kp.right_ankle || kp.left_knee || kp.right_knee) {
      hasLegs += 1;
    } else if (kp.left_hip || kp.right_hip || kp.left_elbow || kp.right_elbow || kp.left_wrist || kp.right_wrist) {
      hasHipsOrWrists += 1;
    } else if (kp.left_shoulder || kp.right_shoulder) {
      hasShoulders += 1;
    } else if (kp.nose || kp.left_eye || kp.right_eye || kp.left_ear || kp.right_ear) {
      hasHeadOnly += 1;
    }
  }

  if (hasLegs > 0) return 'full-figure';
  if (hasHipsOrWrists > 0) return 'upper-body';
  if (hasShoulders > 0) return 'portrait-bust';
  if (hasHeadOnly > 0) return 'closeup-head';
  return 'full-figure';
}

function estimatePartialTorsoLen(kp: Keypoints): number | null {
  const midHip = midpoint(kp.left_hip, kp.right_hip);
  const midShoulder = midpoint(kp.left_shoulder, kp.right_shoulder);
  if (midHip && midShoulder) return Math.max(0.08, dist2D(midHip, midShoulder));
  if (kp.left_shoulder && kp.right_shoulder) {
    return Math.max(0.08, dist2D(kp.left_shoulder, kp.right_shoulder) / 0.52);
  }
  if (kp.left_ear && kp.right_ear) {
    return Math.max(0.08, dist2D(kp.left_ear, kp.right_ear) * 3.1);
  }
  if (kp.left_eye && kp.right_eye) {
    return Math.max(0.08, dist2D(kp.left_eye, kp.right_eye) * 6.4);
  }
  return null;
}

/**
 * Computes clip-wide reference hip/anchor center & torso height so locomotion,
 * bust portraits, and tight close-ups center cleanly on the Bitruvian stage.
 */
export function computeClipReference(
  frames: Person[][],
  mirrorHorizontal: boolean,
): { refHipX: number; refHipY: number; refTorsoLen: number; isPartialCrop: boolean } {
  const xs: number[] = [];
  const ys: number[] = [];
  const torsos: number[] = [];
  let hipSamples = 0;

  for (const frame of frames) {
    const person = pickPrimarySubject(frame);
    if (!person) continue;
    const kp = normalizePersonKeypoints(person, mirrorHorizontal);
    const hip = midpoint(kp.left_hip, kp.right_hip);
    const sh = midpoint(kp.left_shoulder, kp.right_shoulder);
    const headCenter = midpoint(kp.left_eye, kp.right_eye) ?? kp.nose;

    if (hip) {
      hipSamples += 1;
      xs.push(hip.x);
      ys.push(hip.y);
    } else if (sh) {
      xs.push(sh.x);
      ys.push(sh.y + 0.24);
    } else if (headCenter) {
      xs.push(headCenter.x);
      ys.push(headCenter.y + 0.42);
    }

    const est = estimatePartialTorsoLen(kp);
    if (est !== null) torsos.push(est);
  }

  const avg = (arr: number[], fallback: number) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : fallback;

  return {
    refHipX: avg(xs, 0.5),
    refHipY: avg(ys, 0.55),
    refTorsoLen: Math.max(0.08, avg(torsos, 0.24)),
    isPartialCrop: hipSamples === 0,
  };
}

/**
 * Computes signed perpendicular deviation of middle joint (elbow/knee) from chord (root -> effector)
 * to pick natural analytical/FABRIK bend sign even when limbs cross midline.
 */
function inferBendSignFromCoco(
  root: { x: number; y: number },
  mid: { x: number; y: number },
  eff: { x: number; y: number },
  defaultSign: number,
  isRightSide: boolean,
): number {
  const vx = eff.x - root.x;
  const vy = eff.y - root.y;
  const len = Math.hypot(vx, vy);
  if (len < 0.02) return defaultSign;
  // Cross product (eff - root) x (mid - root)
  const cross = vx * (mid.y - root.y) - vy * (mid.x - root.x);
  if (Math.abs(cross) < 0.0005) return defaultSign;
  // In screen space (+X right, +Y down), positive cross means mid is clockwise from chord
  const sign = cross > 0 ? 1 : -1;
  return isRightSide ? sign : sign;
}

/**
 * Computes whole-body Center-of-Mass (CoM) in Bitruvian world coordinates using
 * de Leva anthropometric segment weights (inspired by Abradshaw1/Muybridge).
 */
export function computeSegmentalCoM(by: Record<string, RigNode>): { x: number; y: number } {
  const seg = (aId: string, bId: string, frac: number): [number, number] | null => {
    const a = by[aId];
    const b = by[bId];
    if (!a || !b) return null;
    const pa = pos(a, by);
    const pb = pos(b, by);
    return [pa[0] + (pb[0] - pa[0]) * frac, pa[1] + (pb[1] - pa[1]) * frac];
  };

  const parts: Array<{ pt: [number, number] | null; w: number }> = [
    { pt: by.head ? pos(by.head, by) : null, w: 0.0694 },
    { pt: seg('pelvis', 'thorax', 0.45), w: 0.4346 },
    { pt: seg('humerusL', 'forearmL', 0.436), w: 0.0271 },
    { pt: seg('humerusR', 'forearmR', 0.436), w: 0.0271 },
    { pt: seg('forearmL', 'handL', 0.43), w: 0.0223 },
    { pt: seg('forearmR', 'handR', 0.43), w: 0.0223 },
    { pt: seg('femurL', 'shinL', 0.433), w: 0.1416 },
    { pt: seg('femurR', 'shinR', 0.433), w: 0.1416 },
    { pt: seg('shinL', 'footL', 0.433), w: 0.057 },
    { pt: seg('shinR', 'footR', 0.433), w: 0.057 },
  ];

  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const p of parts) {
    if (!p.pt) continue;
    sx += p.pt[0] * p.w;
    sy += p.pt[1] * p.w;
    sw += p.w;
  }
  if (sw <= 0.001) return { x: 1257, y: 3382 };
  return { x: sx / sw, y: sy / sw };
}

/**
 * Retargets a single COCO-17 person detection onto the Bitruvian cardboard cutout rig.
 */
export function retargetCocoToBitruvian(
  person: Person | null | undefined,
  nodes: RigNode[],
  by: Record<string, RigNode>,
  root: RigNode,
  clipRef: { refHipX: number; refHipY: number; refTorsoLen: number; isPartialCrop?: boolean },
  options: RetargetOptions,
): RetargetFrameResult {
  // Reset all angles to rest first
  for (const n of nodes) {
    n.ang = 0;
    n.flipX = false;
  }
  root.tx = 0;
  root.ty = 0;

  if (!person) {
    solveRig(nodes, by, options.bondOn, 0);
    return {
      pose: Object.fromEntries(nodes.map((n) => [n.id, 0])),
      root: [0, 0],
      bondStrain: getBondStatus(nodes, options.bondOn),
      clampedNodes: [],
      subjectConfidence: 0,
      com: computeSegmentalCoM(by),
    };
  }

  const kp = normalizePersonKeypoints(person, options.mirrorHorizontal);
  const visibleCount = KEYPOINT_NAMES.filter((k) => kp[k] !== null).length;
  const confidence = visibleCount / KEYPOINT_NAMES.length;

  const midHip = midpoint(kp.left_hip, kp.right_hip);
  const midShoulder = midpoint(kp.left_shoulder, kp.right_shoulder);
  const eyeMid = midpoint(kp.left_eye, kp.right_eye);
  const earMid = midpoint(kp.left_ear, kp.right_ear);
  const hasLegs = Boolean(kp.left_knee || kp.right_knee || kp.left_ankle || kp.right_ankle);

  // Bitruvian torso height: pelvis [1257, 3382] to mid-shoulder (~1400) = ~1980 pyxl
  const bitruvianTorsoPx = 1980 * options.torsoScale;
  const estPartial = estimatePartialTorsoLen(kp);
  const frameTorso = estPartial ?? clipRef.refTorsoLen;
  const pxPerNorm = bitruvianTorsoPx / clipRef.refTorsoLen;

  // 1. Root Translation (pelvis if full figure, or anchored quietly for portraits/close-ups)
  if (midHip) {
    root.tx = (midHip.x - clipRef.refHipX) * pxPerNorm;
    root.ty = (midHip.y - clipRef.refHipY) * pxPerNorm;
  } else if (midShoulder) {
    root.tx = Math.max(-280, Math.min(280, (midShoulder.x - clipRef.refHipX) * pxPerNorm * 0.45));
    root.ty = 0;
  }

  // 2. Pelvis Tilt (from left_hip / right_hip line)
  if (kp.left_hip && kp.right_hip && by.pelvis) {
    const hipRad = angle2D(kp.right_hip, kp.left_hip);
    const hipDeg = normalizeDeg(hipRad / DEG);
    by.pelvis.ang = Math.max(-38, Math.min(38, hipDeg));
  }
  solveRig(nodes, by, options.bondOn, 0);

  // 3. Spine (lumbar + thorax) — falls back cleanly to head/shoulder axis on bust portraits
  if (midHip && midShoulder && by.lumbar && by.thorax) {
    const spineWorldRad = angle2D(midHip, midShoulder);
    // Resting spine points straight up (-PI/2)
    const pelvisAng = by.pelvis?.ang ?? 0;
    const relSpineDeg = normalizeDeg((spineWorldRad - -Math.PI / 2) / DEG - pelvisAng);
    const clampedSpine = Math.max(-55, Math.min(55, relSpineDeg));
    by.lumbar.ang = clampAnatomicalAngle(by.lumbar, clampedSpine * 0.55, options.constrainLimits);
    solveRig(nodes, by, options.bondOn, 0);
    by.thorax.ang = clampAnatomicalAngle(by.thorax, clampedSpine * 0.45, options.constrainLimits);
    solveRig(nodes, by, options.bondOn, 0);
  } else if (midShoulder && (kp.nose || eyeMid) && by.lumbar && by.thorax) {
    const headRef = eyeMid ?? kp.nose!;
    const upperLeanDeg = clampAnatomicalAngle(
      by.thorax,
      ((headRef.x - midShoulder.x) / frameTorso) * 28,
      options.constrainLimits,
    );
    by.thorax.ang = upperLeanDeg * 0.65;
    by.lumbar.ang = upperLeanDeg * 0.35;
    solveRig(nodes, by, options.bondOn, 0);
  }

  // 4. Neck & Head (supports both full-body and tight portrait/headshot close-ups)
  if (by.neck && by.head) {
    const bodyAccum = (by.pelvis?.ang ?? 0) + (by.lumbar?.ang ?? 0) + (by.thorax?.ang ?? 0);
    let eyeTiltDeg = 0;
    let hasEyeTilt = false;
    if (kp.left_eye && kp.right_eye) {
      eyeTiltDeg = normalizeDeg(angle2D(kp.right_eye, kp.left_eye) / DEG);
      hasEyeTilt = true;
    } else if (kp.left_ear && kp.right_ear) {
      eyeTiltDeg = normalizeDeg(angle2D(kp.right_ear, kp.left_ear) / DEG);
      hasEyeTilt = true;
    }

    if (midShoulder && (kp.nose || eyeMid)) {
      const targetPt = kp.nose ?? eyeMid!;
      const headDir = angle2D(midShoulder, targetPt);
      const relHeadDeg = worldToLocalAngle(by.neck, headDir - -Math.PI / 2, by);
      by.neck.ang = clampAnatomicalAngle(by.neck, relHeadDeg * 0.45, options.constrainLimits);
      solveRig(nodes, by, options.bondOn, 0);

      let headAng = relHeadDeg * 0.55;
      if (hasEyeTilt) {
        headAng = headAng * 0.55 + (eyeTiltDeg - bodyAccum) * 0.45;
      }
      by.head.ang = clampAnatomicalAngle(by.head, headAng, options.constrainLimits);
      solveRig(nodes, by, options.bondOn, 0);
    } else if (hasEyeTilt || (kp.nose && (eyeMid || earMid))) {
      // Pure tight close-up headshot (no shoulders visible): infer roll + turn/nod directly from facial geometry
      let turnDeg = 0;
      const faceCenter = eyeMid ?? earMid;
      if (kp.nose && faceCenter) {
        const faceSpan =
          kp.left_ear && kp.right_ear
            ? dist2D(kp.left_ear, kp.right_ear)
            : kp.left_eye && kp.right_eye
            ? dist2D(kp.left_eye, kp.right_eye) * 2.2
            : 0.12;
        turnDeg = Math.max(-28, Math.min(28, ((kp.nose.x - faceCenter.x) / Math.max(0.04, faceSpan)) * 34));
      }
      const combined = (hasEyeTilt ? eyeTiltDeg : 0) * 0.78 + turnDeg * 0.38 - bodyAccum;
      by.neck.ang = clampAnatomicalAngle(by.neck, combined * 0.35, options.constrainLimits);
      solveRig(nodes, by, options.bondOn, 0);
      by.head.ang = clampAnatomicalAngle(by.head, combined * 0.65, options.constrainLimits);
      solveRig(nodes, by, options.bondOn, 0);
    }
  }

  // 5. Lotte Reiniger Cutout Shoulder Poise (quiet girdle, zero horizontal-collapse shiver)
  const poise = Math.max(0, Math.min(1, options.shoulderPoise ?? 0.85));
  const restraint = 1 - poise * 0.82; // At 0.85 poise -> ~0.30 amplitude: subtle, composed breath
  const maxSwivel = 11 * (1 - poise * 0.45);
  const maxAcromion = 9 * (1 - poise * 0.45);

  const computeQuietShrug = (shPt: Point): number => {
    if (!midShoulder || !shPt) return 0;
    const rawRel = (midShoulder.y - shPt.y) / frameTorso;
    const deadzone = 0.018 + poise * 0.014;
    if (Math.abs(rawRel) <= deadzone) return 0;
    const trimmed = rawRel - Math.sign(rawRel) * deadzone;
    return Math.tanh(trimmed * 4.2) * 14 * restraint;
  };

  if (midShoulder && kp.left_shoulder && by.swivelL) {
    const shrugDegL = computeQuietShrug(kp.left_shoulder);
    by.swivelL.ang = clampRealisticShoulder(
      by.swivelL,
      Math.max(-maxSwivel, Math.min(maxSwivel, shrugDegL)),
      by,
      false,
    );
    if (by.acromionL) {
      by.acromionL.ang = clampRealisticShoulder(
        by.acromionL,
        Math.max(-maxAcromion, Math.min(maxAcromion, shrugDegL * 0.55)),
        by,
        false,
      );
    }
  }
  if (midShoulder && kp.right_shoulder && by.swivelR) {
    const shrugDegR = computeQuietShrug(kp.right_shoulder);
    by.swivelR.ang = clampRealisticShoulder(
      by.swivelR,
      Math.max(-maxSwivel, Math.min(maxSwivel, -shrugDegR)),
      by,
      false,
    );
    if (by.acromionR) {
      by.acromionR.ang = clampRealisticShoulder(
        by.acromionR,
        Math.max(-maxAcromion, Math.min(maxAcromion, -shrugDegR * 0.55)),
        by,
        false,
      );
    }
  }
  solveRig(nodes, by, options.bondOn, 0);

  // Subtle Reiniger cutout rib poise counter-balance
  if (by.ribL && by.ribR && by.swivelL && by.swivelR) {
    const ribLimit = 2.6 * (1 - poise * 0.4);
    by.ribL.ang = clampAnatomicalAngle(
      by.ribL,
      Math.max(-ribLimit, Math.min(ribLimit, -by.swivelL.ang * 0.14)),
      true,
    );
    by.ribR.ang = clampAnatomicalAngle(
      by.ribR,
      Math.max(-ribLimit, Math.min(ribLimit, -by.swivelR.ang * 0.14)),
      true,
    );
    solveRig(nodes, by, options.bondOn, 0);
  }

  // 6. Limbs: FK Direct Aiming OR Analytical / FABRIK IK
  const ikConfig: IKConfig = {
    ...DEFAULT_IK_CONFIG,
    solver: options.solverMode === 'ik-analytical' ? 'analytical' : 'fabrik',
    groundY: options.groundY,
  };

  const solveArmFK = (
    side: 'L' | 'R',
    sh: Point,
    el: Point,
    wr: Point,
  ) => {
    const u = by['humerus' + side];
    const l = by['forearm' + side];
    const e = by['hand' + side];
    if (!u || !l || !e) return;
    if (sh && el) {
      setWorldDirExact(u, l.piv, angle2D(sh, el), by);
      u.ang = clampAnatomicalAngle(u, u.ang, options.constrainLimits);
      solveRig(nodes, by, options.bondOn, 0);
    }
    if (el && wr) {
      setWorldDirExact(l, e.piv, angle2D(el, wr), by);
      l.ang = clampAnatomicalAngle(l, l.ang, options.constrainLimits);
      solveRig(nodes, by, options.bondOn, 0);
    }
    // Natural hand continuation
    e.ang = clampAnatomicalAngle(e, l.ang * 0.12, options.constrainLimits);
  };

  const solveLegFK = (
    side: 'L' | 'R',
    hp: Point,
    kn: Point,
    ak: Point,
  ) => {
    const u = by['femur' + side];
    const l = by['shin' + side];
    const e = by['foot' + side];
    if (!u || !l || !e) return;
    if (hp && kn) {
      setWorldDirExact(u, l.piv, angle2D(hp, kn), by);
      u.ang = clampAnatomicalAngle(u, u.ang, options.constrainLimits);
      solveRig(nodes, by, options.bondOn, 0);
    }
    if (kn && ak) {
      setWorldDirExact(l, e.piv, angle2D(kn, ak), by);
      l.ang = clampAnatomicalAngle(l, l.ang, options.constrainLimits);
      solveRig(nodes, by, options.bondOn, 0);
    }
    // Keep foot near level with ground when standing
    if (options.groundLock) {
      const thigh = u.ang;
      const shin = l.ang;
      const pelvis = by.pelvis?.ang ?? 0;
      e.ang = clampAnatomicalAngle(e, -(pelvis + thigh + shin) * 0.65, options.constrainLimits);
    }
  };

  const solveLimbWithIK = (
    chainIdx: number,
    rootPt: Point,
    midPt: Point,
    effPt: Point,
  ) => {
    const c = LIMB_CHAINS[chainIdx];
    const U = by[c.upper];
    const L = by[c.lower];
    const E = by[c.effector];
    if (!U || !L || !E || !rootPt || !effPt) return;

    // Scale normalized vector (rootPt -> effPt) relative to Bitruvian limb length & torso scale
    const cocoLimbLen =
      midPt ? dist2D(rootPt, midPt) + dist2D(midPt, effPt) : Math.max(frameTorso * 1.15, dist2D(rootPt, effPt));
    const bitruvianLimbLen =
      Math.hypot(L.piv[0] - U.piv[0], L.piv[1] - U.piv[1]) +
      Math.hypot(E.piv[0] - L.piv[0], E.piv[1] - L.piv[1]);

    const limbScale = bitruvianLimbLen / Math.max(0.08, cocoLimbLen);
    const uWorld = pos(U, by);
    const target: [number, number] = [
      uWorld[0] + (effPt.x - rootPt.x) * limbScale,
      uWorld[1] + (effPt.y - rootPt.y) * limbScale,
    ];

    const bendHint = midPt
      ? inferBendSignFromCoco(rootPt, midPt, effPt, c.bendSign, c.id.endsWith('R'))
      : c.bendSign;

    solveLimbChain(
      c,
      target,
      nodes,
      by,
      options.bondOn,
      0,
      ikConfig,
      options.constrainLimits,
      bendHint,
    );
  };

  if (options.solverMode === 'fk-direct') {
    solveArmFK('L', kp.left_shoulder, kp.left_elbow, kp.left_wrist);
    solveArmFK('R', kp.right_shoulder, kp.right_elbow, kp.right_wrist);
    solveLegFK('L', kp.left_hip, kp.left_knee, kp.left_ankle);
    solveLegFK('R', kp.right_hip, kp.right_knee, kp.right_ankle);
  } else {
    if (kp.left_shoulder && kp.left_wrist) {
      solveLimbWithIK(0, kp.left_shoulder, kp.left_elbow, kp.left_wrist);
    } else {
      solveArmFK('L', kp.left_shoulder, kp.left_elbow, kp.left_wrist);
    }
    if (kp.right_shoulder && kp.right_wrist) {
      solveLimbWithIK(1, kp.right_shoulder, kp.right_elbow, kp.right_wrist);
    } else {
      solveArmFK('R', kp.right_shoulder, kp.right_elbow, kp.right_wrist);
    }
    if (kp.left_hip && kp.left_ankle) {
      solveLimbWithIK(2, kp.left_hip, kp.left_knee, kp.left_ankle);
    } else {
      solveLegFK('L', kp.left_hip, kp.left_knee, kp.left_ankle);
    }
    if (kp.right_hip && kp.right_ankle) {
      solveLimbWithIK(3, kp.right_hip, kp.right_knee, kp.right_ankle);
    } else {
      solveLegFK('R', kp.right_hip, kp.right_knee, kp.right_ankle);
    }

    if (options.groundLock) {
      const slopeRad = (options.floorTiltDeg ?? 0) * DEG;
      for (const side of ['L', 'R'] as const) {
        const e = by['foot' + side];
        if (e) {
          solveRig(nodes, by, options.bondOn, 0);
          alignFootSoleToSlope(e, by, slopeRad, 0.7, options.constrainLimits);
        }
      }
    }
  }

  solveRig(nodes, by, options.bondOn, 0);

  if (options.groundLock && hasLegs) {
    enforceGroundContact(
      nodes,
      by,
      root,
      options.bondOn,
      0,
      options.groundY,
      true,
      1257,
      options.floorTiltDeg ?? 0,
    );
  }

  const clampedNodes: string[] = [];
  const pose: Record<string, number> = {};
  for (const n of nodes) {
    pose[n.id] = Math.round(n.ang * 100) / 100;
    const t = getTensionRatio(n);
    if (t.atLimit || t.nearLimit) {
      clampedNodes.push(n.id);
    }
  }

  return {
    pose,
    root: [Math.round(root.tx * 10) / 10, Math.round(root.ty * 10) / 10],
    bondStrain: getBondStatus(nodes, options.bondOn),
    clampedNodes,
    subjectConfidence: confidence,
    com: computeSegmentalCoM(by),
  };
}

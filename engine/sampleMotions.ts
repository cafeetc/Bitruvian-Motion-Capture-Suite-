import type { Keypoints, Person } from '../types';

export interface SampleMotionClip {
  id: string;
  plate: string;
  name: string;
  subtitle: string;
  sourceUrl: string;
  fps: number;
  frames: Person[][];
}

function makePose(overrides: {
  hipX?: number;
  hipY?: number;
  hipTilt?: number;
  leanX?: number;
  shoulderDrop?: number;
  headX?: number;
  headY?: number;
  lElbow?: [number, number];
  lWrist?: [number, number];
  rElbow?: [number, number];
  rWrist?: [number, number];
  lKnee?: [number, number];
  lAnkle?: [number, number];
  rKnee?: [number, number];
  rAnkle?: [number, number];
}): Person[] {
  const hx = overrides.hipX ?? 0.5;
  const hy = overrides.hipY ?? 0.54;
  const ht = overrides.hipTilt ?? 0;
  const lx = overrides.leanX ?? 0;
  const sd = overrides.shoulderDrop ?? 0;

  const shY = hy - 0.23 + sd;
  const shX = hx + lx;

  const lHip = { x: hx + 0.045, y: hy + ht };
  const rHip = { x: hx - 0.045, y: hy - ht };
  const lSh = { x: shX + 0.078, y: shY + ht * 0.5 };
  const rSh = { x: shX - 0.078, y: shY - ht * 0.5 };

  const nose = {
    x: shX + (overrides.headX ?? 0),
    y: shY - 0.085 + (overrides.headY ?? 0),
  };

  const kp: Keypoints = {
    nose,
    left_eye: { x: nose.x + 0.014, y: nose.y - 0.012 },
    right_eye: { x: nose.x - 0.014, y: nose.y - 0.012 },
    left_ear: { x: nose.x + 0.028, y: nose.y - 0.004 },
    right_ear: { x: nose.x - 0.028, y: nose.y - 0.004 },
    left_shoulder: lSh,
    right_shoulder: rSh,
    left_elbow: overrides.lElbow
      ? { x: lSh.x + overrides.lElbow[0], y: lSh.y + overrides.lElbow[1] }
      : { x: lSh.x + 0.02, y: lSh.y + 0.12 },
    right_elbow: overrides.rElbow
      ? { x: rSh.x + overrides.rElbow[0], y: rSh.y + overrides.rElbow[1] }
      : { x: rSh.x - 0.02, y: rSh.y + 0.12 },
    left_wrist: overrides.lWrist
      ? { x: lSh.x + overrides.lWrist[0], y: lSh.y + overrides.lWrist[1] }
      : { x: lSh.x + 0.03, y: lSh.y + 0.24 },
    right_wrist: overrides.rWrist
      ? { x: rSh.x + overrides.rWrist[0], y: rSh.y + overrides.rWrist[1] }
      : { x: rSh.x - 0.03, y: rSh.y + 0.24 },
    left_hip: lHip,
    right_hip: rHip,
    left_knee: overrides.lKnee
      ? { x: lHip.x + overrides.lKnee[0], y: lHip.y + overrides.lKnee[1] }
      : { x: lHip.x + 0.01, y: lHip.y + 0.19 },
    right_knee: overrides.rKnee
      ? { x: rHip.x + overrides.rKnee[0], y: rHip.y + overrides.rKnee[1] }
      : { x: rHip.x - 0.01, y: rHip.y + 0.19 },
    left_ankle: overrides.lAnkle
      ? { x: lHip.x + overrides.lAnkle[0], y: lHip.y + overrides.lAnkle[1] }
      : { x: lHip.x + 0.015, y: lHip.y + 0.37 },
    right_ankle: overrides.rAnkle
      ? { x: rHip.x + overrides.rAnkle[0], y: rHip.y + overrides.rAnkle[1] }
      : { x: rHip.x - 0.015, y: rHip.y + 0.37 },
  };

  return [{ keypoints: kp }];
}

/**
 * Eadweard Muybridge — Animal Locomotion (1887), Plate 155: Running High Jump.
 * Multi-phase chronophotographic jump cycle: gather, takeoff plant, airborne arch/tuck, landing recoil.
 */
function buildMuybridgePlate155HighJump(): SampleMotionClip {
  const N = 36;
  const frames: Person[][] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const air = Math.max(0, Math.sin(t));
    const gather = Math.max(0, -Math.sin(t)) * 0.55;
    const tuck = Math.pow(air, 1.3);
    const armSweep = Math.sin(t - 0.35);

    const lArmAngle = Math.PI * 0.45 - Math.max(-0.2, armSweep) * 1.65;
    const rArmAngle = Math.PI * 0.55 + Math.max(-0.2, armSweep) * 1.55;

    frames.push(
      makePose({
        hipX: 0.5 + Math.sin(t * 0.5) * 0.025,
        hipY: 0.54 - air * 0.11 + gather * 0.075,
        hipTilt: air * 0.018 * Math.cos(t),
        leanX: -gather * 0.025 + air * 0.015,
        shoulderDrop: gather * 0.028 - air * 0.014,
        lElbow: [Math.cos(lArmAngle) * 0.115, Math.sin(lArmAngle) * 0.115],
        lWrist: [Math.cos(lArmAngle - 0.22) * 0.225, Math.sin(lArmAngle - 0.22) * 0.225],
        rElbow: [Math.cos(rArmAngle) * 0.115, Math.sin(rArmAngle) * 0.115],
        rWrist: [Math.cos(rArmAngle + 0.22) * 0.225, Math.sin(rArmAngle + 0.22) * 0.225],
        lKnee: [0.02 + tuck * 0.08 + gather * 0.05, 0.18 - tuck * 0.11 - gather * 0.05],
        lAnkle: [0.02 + tuck * 0.05, 0.36 - tuck * 0.12 - gather * 0.07],
        rKnee: [-0.02 - tuck * 0.05 - gather * 0.05, 0.18 - tuck * 0.07 - gather * 0.05],
        rAnkle: [-0.02 - tuck * 0.11, 0.36 - tuck * 0.05 - gather * 0.07],
      }),
    );
  }
  return {
    id: 'muybridge-plate-155',
    plate: 'Plate 155',
    name: 'Muybridge · Running High Jump',
    subtitle: 'Animal Locomotion (1887) · Takeoff, airborne tuck & landing recoil',
    sourceUrl: 'https://bodiesinmotion.photo/muybridge',
    fps: 12,
    frames,
  };
}

/**
 * Eadweard Muybridge — Animal Locomotion (1887), Plate 62: Man Running at Half Speed.
 * Cyclic sprint with ballistic double-float suspension, high knee drive, and elbow pump.
 */
function buildMuybridgePlate62Running(): SampleMotionClip {
  const N = 32;
  const frames: Person[][] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const phase = Math.sin(t);
    const bounce = Math.abs(Math.sin(t)) * 0.032;

    frames.push(
      makePose({
        hipX: 0.5 + Math.cos(t) * 0.015,
        hipY: 0.54 - bounce,
        hipTilt: phase * 0.018,
        leanX: 0.02 + Math.cos(t) * 0.016,
        lElbow: [0.04 - phase * 0.07, 0.09 - Math.max(0, -phase) * 0.04],
        lWrist: [0.07 - phase * 0.14, 0.02 - Math.max(0, -phase) * 0.09],
        rElbow: [-0.04 + phase * 0.07, 0.09 - Math.max(0, phase) * 0.04],
        rWrist: [-0.07 + phase * 0.14, 0.02 - Math.max(0, phase) * 0.09],
        lKnee: [0.02 + phase * 0.09, 0.17 - Math.max(0, phase) * 0.08],
        lAnkle: [phase * 0.14 - 0.02, 0.35 - Math.max(0, -phase) * 0.11],
        rKnee: [-0.02 - phase * 0.09, 0.17 - Math.max(0, -phase) * 0.08],
        rAnkle: [-phase * 0.14 + 0.02, 0.35 - Math.max(0, phase) * 0.11],
      }),
    );
  }
  return {
    id: 'muybridge-plate-62',
    plate: 'Plate 62',
    name: 'Muybridge · Man Running',
    subtitle: 'Animal Locomotion (1887) · Half-speed sprint & ballistic CoM arc',
    sourceUrl: 'https://bodiesinmotion.photo/muybridge',
    fps: 12,
    frames,
  };
}

/**
 * Eadweard Muybridge — Animal Locomotion (1887), Plate 44: Man Walking.
 * Classic gridded bipedal gait cycle with heel strike, midstance & contralateral arm swing.
 */
function buildMuybridgePlate44Walking(): SampleMotionClip {
  const N = 32;
  const frames: Person[][] = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const stride = Math.sin(t);
    const bounce = Math.abs(Math.cos(t)) * 0.016;

    frames.push(
      makePose({
        hipX: 0.5 + stride * 0.01,
        hipY: 0.54 - bounce,
        hipTilt: stride * 0.013,
        leanX: Math.cos(t) * 0.01,
        lElbow: [0.03 - stride * 0.045, 0.11 - Math.max(0, -stride) * 0.03],
        lWrist: [0.05 - stride * 0.1, 0.21 - Math.max(0, -stride) * 0.06],
        rElbow: [-0.03 + stride * 0.045, 0.11 - Math.max(0, stride) * 0.03],
        rWrist: [-0.05 + stride * 0.1, 0.21 - Math.max(0, stride) * 0.06],
        lKnee: [stride * 0.055, 0.18 - Math.max(0, stride) * 0.04],
        lAnkle: [stride * 0.105, 0.36 - Math.max(0, -stride) * 0.045],
        rKnee: [-stride * 0.055, 0.18 - Math.max(0, -stride) * 0.04],
        rAnkle: [-stride * 0.105, 0.36 - Math.max(0, stride) * 0.045],
      }),
    );
  }
  return {
    id: 'muybridge-plate-44',
    plate: 'Plate 44',
    name: 'Muybridge · Man Walking',
    subtitle: 'Animal Locomotion (1887) · Gridded stride & ground-locked gait',
    sourceUrl: 'https://bodiesinmotion.photo/muybridge',
    fps: 10,
    frames,
  };
}

/**
 * Eadweard Muybridge — Animal Locomotion (1887), Plate 331: Boxing / Sparring.
 * Sequential punch extension, weight transfer, and shoulder-girdle swivel rotation.
 */
function buildMuybridgePlate331Boxing(): SampleMotionClip {
  const N = 36;
  const frames: Person[][] = [];
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const jab = Math.max(0, Math.sin(u * Math.PI * 2));
    const cross = Math.max(0, -Math.sin(u * Math.PI * 2));
    const bob = Math.abs(Math.sin(u * Math.PI * 4)) * 0.018;

    frames.push(
      makePose({
        hipX: 0.5 + (cross - jab) * 0.025,
        hipY: 0.55 + bob,
        hipTilt: (cross - jab) * 0.012,
        leanX: (cross - jab) * 0.035,
        headX: (cross - jab) * 0.018,
        lElbow: [0.04 + jab * 0.075, 0.06 - jab * 0.08],
        lWrist: [0.01 + jab * 0.165, -0.02 - jab * 0.045],
        rElbow: [-0.05 - cross * 0.075, 0.05 - cross * 0.075],
        rWrist: [-0.02 - cross * 0.155, -0.03 - cross * 0.045],
        lKnee: [0.06, 0.17 - bob],
        lAnkle: [0.08, 0.35 - bob],
        rKnee: [-0.06, 0.17 - bob],
        rAnkle: [-0.08, 0.35 - bob],
      }),
    );
  }
  return {
    id: 'muybridge-plate-331',
    plate: 'Plate 331',
    name: 'Muybridge · Sparring Guard',
    subtitle: 'Animal Locomotion (1887) · Jab-cross torque & clavicle bond strain',
    sourceUrl: 'https://bodiesinmotion.photo/muybridge',
    fps: 12,
    frames,
  };
}

export const SAMPLE_MOTION_CLIPS: SampleMotionClip[] = [
  buildMuybridgePlate155HighJump(),
  buildMuybridgePlate62Running(),
  buildMuybridgePlate44Walking(),
  buildMuybridgePlate331Boxing(),
];

export type RenderMode = 'A' | 'D';

export type EffectorRole = 'handL' | 'handR' | 'footL' | 'footR' | 'head' | null;

export type IKMode = 'fk' | 'fluid' | 'balance' | 'pinFeet' | 'pinAll' | 'pinFull';

export type IKSolverType = 'fabrik' | 'analytical';

export type RetargetSolverMode = 'fk-direct' | 'ik-analytical' | 'ik-fabrik';

export type MotionFeel = 'raw' | 'flow' | 'snap' | 'elastic' | 'mechanical' | 'clockwork';

export type SubjectFraming = 'full-figure' | 'upper-body' | 'portrait-bust' | 'closeup-head';

export interface IKPinEntry {
  pos: [number, number];
  endDir: number;
  pinned: boolean;
}

export interface IKConfig {
  mode: IKMode;
  solver: IKSolverType;
  iterations: number;
  tolerance: number;
  softness: number;
  swivelFollow: number;
  spineStiffness: number;
  footGravity: boolean;
  groundY: number;
  allowStretch: boolean;
  bendOverrides: Record<string, number>;
}

export interface IKOverlayState {
  active: boolean;
  mode: IKMode;
  solver: IKSolverType;
  pins: Record<string, IKPinEntry>;
  groundY: number;
  footGravity: boolean;
  activeChainIds: string[] | null;
  targetPos: [number, number] | null;
}

export interface PerspectiveState {
  enabled: boolean;
  groundY: number;
  horizonY: number;
  vpX: number;
  floorScale: number;
  tiltDownDeg: number;
  depthSpread: number;
}

export type PerspHandle = 'vp' | 'horizon' | 'ground' | 'tilt' | null;

export interface AimConstraint {
  to: string;
  from: [number, number];
  min: number;
  max: number;
}

export interface RawPieceDef {
  i: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  src?: string;
}

export interface RawNodeDef {
  id: string;
  name?: string;
  parent?: string | null;
  pivot: [number, number];
  aim?: AimConstraint | null;
  ang?: number;
  pieces?: RawPieceDef[];
  lock?: boolean | number;
  ghost?: boolean | number;
  bar?: [string, string] | null;
  flipX?: boolean;
}

export interface RawRigDef {
  W: number;
  H: number;
  nodes: RawNodeDef[];
  dg?: number;
  jn?: number;
}

export interface RigPiece extends RawPieceDef {
  node?: RigNode;
  i0?: number;
  wing?: boolean;
  bm?: CanvasImageSource & { width: number; height: number };
  bm0?: CanvasImageSource & { width: number; height: number };
  full0?: CanvasImageSource & { width: number; height: number };
  m?: Uint8Array;
  mw?: number;
  mh?: number;
  st?: number;
  sib?: [RigPiece, RigPiece];
  mir?: boolean;
  gotzManaged?: boolean;
  restBox?: { x: number; y: number; w: number; h: number };
}

export interface RigNode {
  id: string;
  name: string;
  parent: string | null;
  aim: AimConstraint | null;
  pieces: RigPiece[];
  piv: [number, number];
  rest: [number, number];
  ang: number;
  tx: number;
  ty: number;
  w: Float64Array;
  eff: number;
  bond: RigNode | null;
  lock: boolean;
  ghost: boolean;
  bar: [string, string] | null;
  at: [number, number] | null;
  limits: [number, number];
  effectorRole: EffectorRole;
  chainId: string | null;
  flipX: boolean;
}

export interface LimbChainDef {
  id: string;
  label: string;
  swiv?: string;
  upper: string;
  lower: string;
  effector: string;
  bendSign: number;
}

export interface PoseSnapshot {
  pose: Record<string, number>;
  root: [number, number];
  flipX?: Record<string, boolean>;
}

export interface Keyframe {
  f: number;
  a: number[];
  x: number;
  y: number;
}

export interface CameraBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface BondStatusItem {
  side: string;
  delta: number;
  strained: boolean;
}

export interface PinnedEffectors {
  footL: boolean;
  footR: boolean;
  handL: boolean;
  handR: boolean;
}

export interface RetargetOptions {
  solverMode: RetargetSolverMode;
  constrainLimits: boolean;
  bondOn: boolean;
  groundLock: boolean;
  groundY: number;
  mirrorHorizontal: boolean;
  smoothing: number;
  torsoScale: number;
  shoulderPoise: number;
  loopLearning: boolean;
  advancedPhysics: boolean;
  groundPinStrength: number;
  handGroundPhysics: boolean;
  floorTiltDeg: number;
  depthEmulation: number;
  pinnedEffectors: PinnedEffectors;
}

export interface CoMPoint {
  x: number;
  y: number;
}

export interface RetargetFrameResult {
  pose: Record<string, number>;
  root: [number, number];
  bondStrain: BondStatusItem[];
  clampedNodes: string[];
  subjectConfidence: number;
  com: CoMPoint;
}

export interface LoopLearnerState {
  loopPass: number;
  baseFrames: RetargetFrameResult[];
  refinedFrames: RetargetFrameResult[];
  frameDeltas: Array<Record<string, number>>;
  rootDeltas: Array<[number, number]>;
  postureBias: Record<string, number>;
  editedFrameCount: number;
}


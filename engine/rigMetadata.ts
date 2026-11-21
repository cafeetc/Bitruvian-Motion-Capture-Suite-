import type { EffectorRole, LimbChainDef } from './types';

export const ANATOMICAL_LIMITS: Record<string, [number, number]> = {
  pelvis: [-180, 180],
  hipR: [-145, 145],
  hipL: [-145, 145],
  lumbar: [-48, 48],
  thorax: [-42, 42],
  ribR: [-28, 28],
  ribL: [-28, 28],
  neck: [-45, 45],
  head: [-65, 65],
  lip: [-35, 18],
  braceL: [-18, 18],
  braceR: [-18, 18],
  swivelL: [-42, 42],
  swivelR: [-42, 42],
  acromionL: [-45, 60],
  acromionR: [-60, 45],
  humerusL: [-175, 165],
  humerusR: [-165, 175],
  forearmL: [-155, 15],
  forearmR: [-15, 155],
  handL: [-85, 85],
  handR: [-85, 85],
  thumbL: [-75, 75],
  thumbR: [-75, 75],
  fingerL: [-95, 45],
  fingerR: [-45, 95],
  femurL: [-135, 120],
  femurR: [-120, 135],
  shinL: [-15, 150],
  shinR: [-150, 15],
  footL: [-65, 75],
  footR: [-75, 65],
};

export const LIMB_CHAINS: LimbChainDef[] = [
  { id: 'armL', label: 'Left Arm', swiv: 'swivelL', upper: 'humerusL', lower: 'forearmL', effector: 'handL', bendSign: -1 },
  { id: 'armR', label: 'Right Arm', swiv: 'swivelR', upper: 'humerusR', lower: 'forearmR', effector: 'handR', bendSign: 1 },
  { id: 'legL', label: 'Left Leg', upper: 'femurL', lower: 'shinL', effector: 'footL', bendSign: 1 },
  { id: 'legR', label: 'Right Leg', upper: 'femurR', lower: 'shinR', effector: 'footR', bendSign: -1 },
];

export const EFFECTOR_ROLES: Record<string, EffectorRole> = {
  handL: 'handL',
  handR: 'handR',
  footL: 'footL',
  footR: 'footR',
  head: 'head',
};

export interface RoadmapMilestone {
  phase: string;
  title: string;
  status: 'active' | 'integrated' | 'planned';
  summary: string;
}

export const BITRUVIAN_MOCAP_ROADMAP: RoadmapMilestone[] = [
  {
    phase: 'Base FK',
    title: '2500×8742 Cardboard Cutout Hierarchy & Shoulder Poise',
    status: 'integrated',
    summary: 'Topological FK rig with Lotte Reiniger cutout shoulder restraint, closed-chain clavicle bond, and green pin pivots.',
  },
  {
    phase: 'Phase 1–2',
    title: 'Anatomical Limits & 1-Point Perspective Stage',
    status: 'integrated',
    summary: 'Joint range clamping, Vitruvian 1H–7H proportion guides, and draggable ground/horizon stage.',
  },
  {
    phase: 'Phase 4',
    title: 'Motion Feel Timing & 5-Frame Wing Blur',
    status: 'integrated',
    summary: 'Flow, Snap, Elastic, Mechanical, and Clockwork timing curves with 5-frame aerodynamic wing motion blur.',
  },
  {
    phase: 'Phase 5',
    title: 'Live Posing, Cyclic Loop Learner & Muybridge Datasets',
    status: 'active',
    summary:
      'Live posing while in motion with cyclic loop cleanup, Eadweard Muybridge plates, video pose extraction, and JSON/BSK dataset import with de Leva CoM tracking.',
  },
];

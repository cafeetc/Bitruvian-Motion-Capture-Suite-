import type { KeypointName } from './types';

export const TARGET_FPS = 10;

export const SKELETON_CONNECTIONS: [KeypointName, KeypointName][] = [
  // Torso
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],

  // Left Arm
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],

  // Right Arm
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],

  // Left Leg
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],

  // Right Leg
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],

  // Head
  ['left_eye', 'right_eye'],
  ['nose', 'left_eye'],
  ['nose', 'right_eye'],
  ['left_eye', 'left_ear'],
  ['right_eye', 'right_ear'],
];

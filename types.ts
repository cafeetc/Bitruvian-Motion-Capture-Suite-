
export type Point = { x: number; y: number } | null;

export interface Keypoints {
  nose: Point;
  left_eye: Point;
  right_eye: Point;
  left_ear: Point;
  right_ear: Point;
  left_shoulder: Point;
  right_shoulder: Point;
  left_elbow: Point;
  right_elbow: Point;
  left_wrist: Point;
  right_wrist: Point;
  left_hip: Point;
  right_hip: Point;
  left_knee: Point;
  right_knee: Point;
  left_ankle: Point;
  right_ankle: Point;
}

export type KeypointName = keyof Keypoints;

export interface Person {
  keypoints: Keypoints;
}

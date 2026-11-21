import type { KeypointName, Keypoints, Person } from '../types';
import type { PoseSnapshot, RigNode } from './types';

const COCO_ORDER: KeypointName[] = [
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

export type ImportedDataset =
  | {
      kind: 'coco';
      label: string;
      summary: string;
      frames: Person[][];
    }
  | {
      kind: 'bsk';
      label: string;
      summary: string;
      keyframes: PoseSnapshot[];
    };

function emptyKeypoints(): Keypoints {
  const out = {} as Keypoints;
  for (const name of COCO_ORDER) out[name] = null;
  return out;
}

function parseTupleArrayToKeypoints(arr: unknown[]): Keypoints | null {
  if (arr.length === 51 && typeof arr[0] === 'number') {
    const kp = emptyKeypoints();
    for (let i = 0; i < 17; i++) {
      const x = Number(arr[i * 3]);
      const y = Number(arr[i * 3 + 1]);
      const c = Number(arr[i * 3 + 2] ?? 1);
      if (Number.isFinite(x) && Number.isFinite(y) && c > 0.05 && (x !== 0 || y !== 0)) {
        kp[COCO_ORDER[i]] = { x, y };
      }
    }
    return kp;
  }

  if (arr.length >= 17 && Array.isArray(arr[0])) {
    const kp = emptyKeypoints();
    for (let i = 0; i < 17; i++) {
      const pt = arr[i] as unknown[];
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const x = Number(pt[0]);
      const y = Number(pt[1]);
      const c = pt.length >= 3 ? Number(pt[2]) : 1;
      if (Number.isFinite(x) && Number.isFinite(y) && c > 0.05 && (x !== 0 || y !== 0)) {
        kp[COCO_ORDER[i]] = { x, y };
      }
    }
    return kp;
  }

  return null;
}

function parseNamedKeypoints(obj: Record<string, unknown>): Keypoints | null {
  const kp = emptyKeypoints();
  let hits = 0;
  for (const name of COCO_ORDER) {
    const raw = obj[name];
    if (!raw) continue;
    if (Array.isArray(raw) && raw.length >= 2) {
      const x = Number(raw[0]);
      const y = Number(raw[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        kp[name] = { x, y };
        hits += 1;
      }
    } else if (typeof raw === 'object' && raw !== null) {
      const p = raw as Record<string, unknown>;
      const x = Number(p.x);
      const y = Number(p.y);
      const conf = p.confidence !== undefined ? Number(p.confidence) : p.score !== undefined ? Number(p.score) : 1;
      if (Number.isFinite(x) && Number.isFinite(y) && conf > 0.05) {
        kp[name] = { x, y };
        hits += 1;
      }
    }
  }
  return hits >= 3 ? kp : null;
}

function normalizeFramesIfPixelCoords(frames: Person[][]): { frames: Person[][]; wasPixel: boolean } {
  let maxVal = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const frame of frames) {
    for (const person of frame) {
      for (const name of COCO_ORDER) {
        const pt = person.keypoints[name];
        if (!pt) continue;
        maxVal = Math.max(maxVal, Math.abs(pt.x), Math.abs(pt.y));
        minX = Math.min(minX, pt.x);
        maxX = Math.max(maxX, pt.x);
        minY = Math.min(minY, pt.y);
        maxY = Math.max(maxY, pt.y);
      }
    }
  }

  if (maxVal <= 1.5 || !Number.isFinite(minX)) {
    return { frames, wasPixel: false };
  }

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.max(spanX, spanY) * 1.35;
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;

  const normalized = frames.map((frame) =>
    frame.map((person) => {
      const kp = emptyKeypoints();
      for (const name of COCO_ORDER) {
        const pt = person.keypoints[name];
        if (pt) {
          kp[name] = {
            x: Math.max(0.05, Math.min(0.95, 0.5 + (pt.x - cx) / scale)),
            y: Math.max(0.05, Math.min(0.95, 0.52 + (pt.y - cy) / scale)),
          };
        }
      }
      return { keypoints: kp };
    }),
  );

  return { frames: normalized, wasPixel: true };
}

/**
 * Parses uploaded JSON pose datasets:
 * - Bitruvian .bsk.json ({ bones, keyframes })
 * - App-exported Person[][] arrays
 * - Frame arrays of { keypoints } / flat 51-value COCO arrays / 17x[x,y,score] tuples
 */
export function parseMotionDataset(
  rawText: string,
  nodes: RigNode[],
  fileName = 'dataset.json',
): ImportedDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Dataset must be valid JSON.');
  }

  // 1. Check Bitruvian .bsk.json format
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).keyframes)
  ) {
    const obj = parsed as {
      name?: string;
      bones?: Array<{ name: string }>;
      keyframes: Array<{ f?: number; a?: number[]; x?: number; y?: number }>;
    };
    if (obj.keyframes.length === 0) {
      throw new Error('The .bsk.json file contains 0 keyframes.');
    }
    const boneNames = obj.bones?.map((b) => b.name) ?? nodes.map((n) => n.id);
    const keyframes: PoseSnapshot[] = obj.keyframes.map((kf) => {
      const pose: Record<string, number> = {};
      const angles = kf.a ?? [];
      for (let i = 0; i < boneNames.length; i++) {
        const val = angles[i];
        if (typeof val === 'number' && Number.isFinite(val)) {
          pose[boneNames[i]] = val;
        }
      }
      return {
        pose,
        root: [Number(kf.x ?? 0), Number(kf.y ?? 0)],
      };
    });
    return {
      kind: 'bsk',
      label: obj.name || fileName.replace(/\.(bsk\.)?json$/i, ''),
      summary: `${keyframes.length} Bitruvian keyframes loaded`,
      keyframes,
    };
  }

  // 2. Unwrap { frames: [...] } or { sequence: [...] } or { annotations: [...] }
  let list: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (typeof parsed === 'object' && parsed !== null) {
    const rec = parsed as Record<string, unknown>;
    const candidate = rec.frames ?? rec.sequence ?? rec.poses ?? rec.annotations;
    if (Array.isArray(candidate)) list = candidate;
  }

  if (!list || list.length === 0) {
    throw new Error('Expected a JSON array of frames or an object with frames/keyframes.');
  }

  const frames: Person[][] = [];
  for (const item of list) {
    if (Array.isArray(item)) {
      if (item.length > 0 && typeof item[0] === 'object' && item[0] !== null && !Array.isArray(item[0])) {
        const first = item[0] as Record<string, unknown>;
        const rawKp = (first.keypoints as Record<string, unknown> | undefined) ?? first;
        const kp = parseNamedKeypoints(rawKp);
        if (kp) {
          frames.push([{ keypoints: kp }]);
          continue;
        }
      }
      if (item.length > 0 && Array.isArray(item[0]) && item[0].length === 51 && typeof item[0][0] === 'number') {
        const kpNested = parseTupleArrayToKeypoints(item[0]);
        if (kpNested) {
          frames.push([{ keypoints: kpNested }]);
          continue;
        }
      }
      const kpTuple = parseTupleArrayToKeypoints(item);
      if (kpTuple) {
        frames.push([{ keypoints: kpTuple }]);
        continue;
      }
    } else if (typeof item === 'object' && item !== null) {
      const rec = item as Record<string, unknown>;
      if (Array.isArray(rec.keypoints)) {
        const kpTuple = parseTupleArrayToKeypoints(rec.keypoints);
        if (kpTuple) {
          frames.push([{ keypoints: kpTuple }]);
          continue;
        }
      }
      const rawKp =
        typeof rec.keypoints === 'object' && rec.keypoints !== null && !Array.isArray(rec.keypoints)
          ? (rec.keypoints as Record<string, unknown>)
          : rec;
      const kp = parseNamedKeypoints(rawKp);
      if (kp) {
        frames.push([{ keypoints: kp }]);
      }
    }
  }

  if (frames.length === 0) {
    throw new Error('No valid COCO-17 or named pose frames were found in this JSON file.');
  }

  const { frames: normalized, wasPixel } = normalizeFramesIfPixelCoords(frames);
  return {
    kind: 'coco',
    label: fileName.replace(/\.json$/i, ''),
    summary: `${normalized.length} frames · ${wasPixel ? 'pixel coords auto-normalized' : 'normalized COCO-17'}`,
    frames: normalized,
  };
}

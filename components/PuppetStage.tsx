import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Camera,
  Eye,
  Focus,
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Sparkles,
  Wind,
} from 'lucide-react';
import { StageRenderer } from '../engine/canvasRenderer';
import {
  DEG,
  clampAnatomicalAngle,
  clampRealisticShoulder,
  computeFramingCamera,
  hitTestPiece,
  normalizeDeg,
  parentOf,
  pos,
  solveRig,
} from '../engine/fkEngine';
import {
  DEFAULT_IK_CONFIG,
  findLimbChainForNode,
  hitPerspHandle,
  solveLimbChain,
} from '../engine/ikEngine';
import type {
  CoMPoint,
  MotionFeel,
  PerspHandle,
  PerspectiveState,
  PinnedEffectors,
  PoseSnapshot,
  RenderMode,
  RetargetSolverMode,
  RigNode,
  RigPiece,
  SubjectFraming,
} from '../engine/types';
import type { Person } from '../types';

export interface RigRuntime {
  W: number;
  H: number;
  nodes: RigNode[];
  by: Record<string, RigNode>;
  root: RigNode;
  pieces: RigPiece[];
}

interface PuppetStageProps {
  rig: RigRuntime | null;
  rigError: string | null;
  currentFrame: number;
  totalFrames: number;
  isPlaying: boolean;
  fps: number;
  motionFeel: MotionFeel;
  renderMode: RenderMode;
  showBones: boolean;
  showGuides: boolean;
  showJointPins: boolean;
  constrainLimits: boolean;
  bondOn: boolean;
  showMotionBlur: boolean;
  showCoM: boolean;
  showCocoOverlay: boolean;
  mirrorHorizontal: boolean;
  handGroundPhysics: boolean;
  pinnedEffectors: PinnedEffectors;
  solverMode: RetargetSolverMode;
  persp: PerspectiveState;
  selectedNodeId: string | null;
  currentCocoFrame: Person | null;
  trailPoses: PoseSnapshot[];
  comTrail: CoMPoint[];
  currentCom: CoMPoint | null;
  renderTick: number;
  subjectFraming: SubjectFraming;
  autoZoomFraming: boolean;
  framingNonce: number;
  onToggleAutoZoomFraming: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onLivePose: (
    activeNodeIds: string[],
    pose: Record<string, number>,
    root: [number, number],
    isFinal: boolean,
  ) => void;
  onPerspChange: (next: PerspectiveState) => void;
  onTogglePlay: () => void;
  onStepFrame: (delta: number) => void;
  onScrubFrame: (frameIndex: number) => void;
  onFpsChange: (fps: number) => void;
  onMotionFeelChange: (feel: MotionFeel) => void;
  onRenderModeChange: (mode: RenderMode) => void;
  onToggleBones: () => void;
  onToggleMotionBlur: () => void;
  onExportPng: (canvas: HTMLCanvasElement) => void;
}

const FRAMING_BADGE: Record<SubjectFraming, string> = {
  'full-figure': 'Full Rig',
  'upper-body': 'Upper Crop',
  'portrait-bust': 'Bust Zoom',
  'closeup-head': 'Head Zoom',
};

export const PuppetStage: React.FC<PuppetStageProps> = ({
  rig,
  rigError,
  currentFrame,
  totalFrames,
  isPlaying,
  fps,
  motionFeel,
  renderMode,
  showBones,
  showGuides,
  showJointPins,
  constrainLimits,
  bondOn,
  showMotionBlur,
  showCoM,
  showCocoOverlay,
  mirrorHorizontal,
  handGroundPhysics,
  pinnedEffectors,
  solverMode,
  persp,
  selectedNodeId,
  currentCocoFrame,
  trailPoses,
  comTrail,
  currentCom,
  renderTick,
  subjectFraming,
  autoZoomFraming,
  framingNonce,
  onToggleAutoZoomFraming,
  onSelectNode,
  onLivePose,
  onPerspChange,
  onTogglePlay,
  onStepFrame,
  onScrubFrame,
  onFpsChange,
  onMotionFeelChange,
  onRenderModeChange,
  onToggleBones,
  onToggleMotionBlur,
  onExportPng,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const camRef = useRef<{ z: number; ox: number; oy: number; dpr: number; fitted: boolean }>({
    z: 0.1,
    ox: 100,
    oy: 20,
    dpr: 1,
    fitted: false,
  });
  const glideRafRef = useRef<number>(0);

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoverPersp, setHoverPersp] = useState<PerspHandle>(null);
  const [draggingPersp, setDraggingPersp] = useState<PerspHandle>(null);

  const dragStateRef = useRef<{
    kind: 'none' | 'pan' | 'fk' | 'ik' | 'persp';
    node?: RigNode;
    perspHandle?: PerspHandle;
    startClientX: number;
    startClientY: number;
    startOx: number;
    startOy: number;
    startAng: number;
    startPointerAngle: number;
    activeChainIds: string[];
    worldTarget?: [number, number];
    liveAng?: number;
    liveRoot?: [number, number];
  }>({
    kind: 'none',
    startClientX: 0,
    startClientY: 0,
    startOx: 0,
    startOy: 0,
    startAng: 0,
    startPointerAngle: 0,
    activeChainIds: [],
  });

  const computeTargetCam = useCallback(
    (overrideFraming?: SubjectFraming) => {
      if (!rig || !canvasRef.current) return null;
      const cv = canvasRef.current;
      if (cv.width <= 0 || cv.height <= 0) return null;
      const effectiveFraming: SubjectFraming =
        overrideFraming ?? (autoZoomFraming ? subjectFraming : 'full-figure');
      return computeFramingCamera(
        effectiveFraming,
        rig.by,
        rig.pieces,
        rig.W,
        rig.H,
        cv.width,
        cv.height,
        camRef.current.dpr,
      );
    },
    [rig, autoZoomFraming, subjectFraming],
  );

  const fitToStage = useCallback(
    (overrideFraming?: SubjectFraming) => {
      const target = computeTargetCam(overrideFraming);
      if (!target) return;
      camRef.current.z = target.z;
      camRef.current.ox = target.ox;
      camRef.current.oy = target.oy;
      camRef.current.fitted = true;
    },
    [computeTargetCam],
  );

  const paintStage = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !rig) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    if (!rendererRef.current) {
      rendererRef.current = new StageRenderer();
    }

    if (!camRef.current.fitted && cv.width > 0 && cv.height > 0) {
      fitToStage();
    }

    // Preserve active live FK/IK limb drag while playback continues smoothly
    const ds = dragStateRef.current;
    if (ds.kind === 'ik' && ds.node && ds.worldTarget) {
      const chain = findLimbChainForNode(ds.node.id);
      if (chain) {
        solveLimbChain(
          chain,
          ds.worldTarget,
          rig.nodes,
          rig.by,
          bondOn,
          0,
          {
            ...DEFAULT_IK_CONFIG,
            solver: solverMode === 'ik-analytical' ? 'analytical' : 'fabrik',
          },
          constrainLimits,
        );
      }
    } else if (ds.kind === 'fk' && ds.node) {
      if (!ds.node.parent && ds.liveRoot) {
        ds.node.tx = ds.liveRoot[0];
        ds.node.ty = ds.liveRoot[1];
      } else if (ds.node.parent && ds.liveAng !== undefined) {
        ds.node.ang = ds.liveAng;
      }
    }

    solveRig(rig.nodes, rig.by, bondOn, 0);

    rendererRef.current.render({
      cv,
      ctx,
      nodes: rig.nodes,
      by: rig.by,
      pieces: rig.pieces,
      sel: selectedNodeId ? rig.by[selectedNodeId] ?? null : null,
      hov: hoveredNodeId ? rig.by[hoveredNodeId] ?? null : null,
      W: rig.W,
      H: rig.H,
      z: camRef.current.z,
      ox: camRef.current.ox,
      oy: camRef.current.oy,
      dpr: camRef.current.dpr,
      mode: renderMode,
      showBones,
      showGuides,
      showJointPins,
      constrainLimits,
      bondOn,
      bgColor: '#121315',
      trailPoses: showMotionBlur ? trailPoses : [],
      comTrail: showCoM ? comTrail : [],
      currentCom: showCoM ? currentCom : null,
      showCoM,
      persp,
      hoverPersp,
      draggingPersp,
      cocoOverlay: currentCocoFrame,
      showCocoOverlay,
      mirrorHorizontal,
      handGroundPhysics,
      pinnedEffectors,
    });
  }, [
    rig,
    bondOn,
    solverMode,
    selectedNodeId,
    hoveredNodeId,
    renderMode,
    showBones,
    showGuides,
    showJointPins,
    constrainLimits,
    showMotionBlur,
    trailPoses,
    showCoM,
    comTrail,
    currentCom,
    persp,
    hoverPersp,
    draggingPersp,
    currentCocoFrame,
    showCocoOverlay,
    mirrorHorizontal,
    handGroundPhysics,
    pinnedEffectors,
    fitToStage,
  ]);

  // Smoothly glide camera whenever detected subject framing or auto-zoom changes
  useEffect(() => {
    if (!rig || !camRef.current.fitted) return;
    const target = computeTargetCam();
    if (!target) return;

    cancelAnimationFrame(glideRafRef.current);
    const startZ = camRef.current.z;
    const startOx = camRef.current.ox;
    const startOy = camRef.current.oy;
    const t0 = performance.now();
    const durationMs = 260;

    const step = (now: number) => {
      const raw = Math.min(1, (now - t0) / durationMs);
      const ease = 1 - Math.pow(1 - raw, 3);
      camRef.current.z = startZ + (target.z - startZ) * ease;
      camRef.current.ox = startOx + (target.ox - startOx) * ease;
      camRef.current.oy = startOy + (target.oy - startOy) * ease;
      paintStage();
      if (raw < 1) {
        glideRafRef.current = requestAnimationFrame(step);
      }
    };

    glideRafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(glideRafRef.current);
  }, [rig, subjectFraming, autoZoomFraming, framingNonce, computeTargetCam, paintStage]);

  // ResizeObserver for crisp HiDPI canvas sizing
  useEffect(() => {
    const container = containerRef.current;
    const cv = canvasRef.current;
    if (!container || !cv) return;

    const syncSize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(300, Math.round(rect.width * dpr));
      const h = Math.max(300, Math.round(rect.height * dpr));
      if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
        camRef.current.dpr = dpr;
        camRef.current.fitted = false;
      }
      paintStage();
    };

    syncSize();
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [paintStage]);

  useEffect(() => {
    paintStage();
  }, [paintStage, renderTick]);

  const toWorld = (clientX: number, clientY: number): [number, number] => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    const dpr = camRef.current.dpr;
    const sx = (clientX - rect.left) * dpr;
    const sy = (clientY - rect.top) * dpr;
    return [
      (sx - camRef.current.ox) / camRef.current.z,
      (sy - camRef.current.oy) / camRef.current.z,
    ];
  };

  const snapshotPose = () => {
    if (!rig) return null;
    return {
      pose: Object.fromEntries(rig.nodes.map((n) => [n.id, Math.round(n.ang * 100) / 100])),
      root: [Math.round(rig.root.tx * 10) / 10, Math.round(rig.root.ty * 10) / 10] as [number, number],
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!rig || !canvasRef.current) return;
    cancelAnimationFrame(glideRafRef.current);
    canvasRef.current.setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);

    const pHandle = hitPerspHandle(w, persp, camRef.current);
    if (pHandle) {
      setDraggingPersp(pHandle);
      dragStateRef.current = {
        kind: 'persp',
        perspHandle: pHandle,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startOx: camRef.current.ox,
        startOy: camRef.current.oy,
        startAng: 0,
        startPointerAngle: 0,
        activeChainIds: [],
      };
      return;
    }

    const hit = hitTestPiece(w, rig.pieces);
    if (hit) {
      const node = hit.node;
      onSelectNode(node.id);
      const chain = solverMode !== 'fk-direct' ? findLimbChainForNode(node.id) : null;

      if (chain && (node.id === chain.effector || node.id.startsWith('hand') || node.id.startsWith('foot'))) {
        dragStateRef.current = {
          kind: 'ik',
          node,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startOx: camRef.current.ox,
          startOy: camRef.current.oy,
          startAng: node.ang,
          startPointerAngle: 0,
          activeChainIds: [chain.upper, chain.lower, chain.effector],
          worldTarget: w,
        };
      } else {
        const pivotWorld = pos(node, rig.by);
        const startPtrAng = Math.atan2(w[1] - pivotWorld[1], w[0] - pivotWorld[0]);
        dragStateRef.current = {
          kind: 'fk',
          node,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startOx: camRef.current.ox,
          startOy: camRef.current.oy,
          startAng: node.ang,
          startPointerAngle: startPtrAng,
          activeChainIds: [node.id],
          liveAng: node.ang,
          liveRoot: !node.parent ? [node.tx, node.ty] : undefined,
        };
      }
      return;
    }

    onSelectNode(null);
    dragStateRef.current = {
      kind: 'pan',
      startClientX: e.clientX,
      startClientY: e.clientY,
      startOx: camRef.current.ox,
      startOy: camRef.current.oy,
      startAng: 0,
      startPointerAngle: 0,
      activeChainIds: [],
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!rig) return;
    const w = toWorld(e.clientX, e.clientY);
    const ds = dragStateRef.current;

    if (ds.kind === 'none') {
      const pHandle = hitPerspHandle(w, persp, camRef.current);
      setHoverPersp(pHandle);
      if (!pHandle) {
        const hit = hitTestPiece(w, rig.pieces);
        setHoveredNodeId(hit?.node.id ?? null);
      } else {
        setHoveredNodeId(null);
      }
      return;
    }

    if (ds.kind === 'pan') {
      const dpr = camRef.current.dpr;
      camRef.current.ox = ds.startOx + (e.clientX - ds.startClientX) * dpr;
      camRef.current.oy = ds.startOy + (e.clientY - ds.startClientY) * dpr;
      paintStage();
      return;
    }

    if (ds.kind === 'persp' && ds.perspHandle) {
      if (ds.perspHandle === 'vp') {
        onPerspChange({ ...persp, vpX: w[0], horizonY: Math.min(persp.groundY - 120, w[1]) });
      } else if (ds.perspHandle === 'horizon') {
        onPerspChange({ ...persp, horizonY: Math.min(persp.groundY - 120, w[1]) });
      } else if (ds.perspHandle === 'ground') {
        const slopeOff = (w[0] - persp.vpX) * Math.tan((persp.tiltDownDeg ?? 0) * DEG);
        onPerspChange({ ...persp, groundY: Math.max(persp.horizonY + 120, w[1] - slopeOff) });
      } else if (ds.perspHandle === 'tilt') {
        const dx = Math.max(220, w[0] - persp.vpX);
        const deg = Math.max(-18, Math.min(18, Math.atan2(w[1] - persp.groundY, dx) / DEG));
        onPerspChange({ ...persp, tiltDownDeg: Math.round(deg * 2) / 2 });
      }
      return;
    }

    if (ds.kind === 'fk' && ds.node) {
      const node = ds.node;
      if (!node.parent) {
        const dx = (e.clientX - ds.startClientX) * (camRef.current.dpr / camRef.current.z);
        const dy = (e.clientY - ds.startClientY) * (camRef.current.dpr / camRef.current.z);
        node.tx += dx;
        node.ty += dy;
        ds.liveRoot = [node.tx, node.ty];
        ds.startClientX = e.clientX;
        ds.startClientY = e.clientY;
      } else {
        const pivotWorld = pos(node, rig.by);
        const ptrAng = Math.atan2(w[1] - pivotWorld[1], w[0] - pivotWorld[0]);
        const par = parentOf(node, rig.by);
        const pW = par ? par.w : [1, 0, 0, 1, 0, 0];
        const det = pW[0] * pW[3] - pW[1] * pW[2];
        const sign = det < 0 ? -1 : 1;
        const deltaDeg = ((ptrAng - ds.startPointerAngle) / DEG) * sign;
        let next = normalizeDeg(ds.startAng + deltaDeg);
        next = clampAnatomicalAngle(node, next, constrainLimits);
        next = clampRealisticShoulder(node, next, rig.by, false);
        node.ang = next;
        ds.liveAng = next;
      }
      solveRig(rig.nodes, rig.by, bondOn, 0);
      paintStage();
      const snap = snapshotPose();
      if (snap) {
        onLivePose(ds.activeChainIds, snap.pose, snap.root, false);
      }
      return;
    }

    if (ds.kind === 'ik' && ds.node) {
      ds.worldTarget = w;
      const chain = findLimbChainForNode(ds.node.id);
      if (chain) {
        solveLimbChain(
          chain,
          w,
          rig.nodes,
          rig.by,
          bondOn,
          0,
          {
            ...DEFAULT_IK_CONFIG,
            solver: solverMode === 'ik-analytical' ? 'analytical' : 'fabrik',
          },
          constrainLimits,
        );
        paintStage();
        const snap = snapshotPose();
        if (snap) {
          onLivePose(ds.activeChainIds, snap.pose, snap.root, false);
        }
      }
    }
  };

  const handlePointerUp = () => {
    const ds = dragStateRef.current;
    if ((ds.kind === 'fk' || ds.kind === 'ik') && ds.node) {
      const snap = snapshotPose();
      if (snap && ds.activeChainIds.length > 0) {
        onLivePose(ds.activeChainIds, snap.pose, snap.root, true);
      }
    }
    setDraggingPersp(null);
    dragStateRef.current.kind = 'none';
    dragStateRef.current.activeChainIds = [];
    dragStateRef.current.worldTarget = undefined;
    dragStateRef.current.liveAng = undefined;
    dragStateRef.current.liveRoot = undefined;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    cancelAnimationFrame(glideRafRef.current);
    const rect = canvasRef.current.getBoundingClientRect();
    const dpr = camRef.current.dpr;
    const sx = (e.clientX - rect.left) * dpr;
    const sy = (e.clientY - rect.top) * dpr;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const nextZ = Math.max(0.03, Math.min(1.25, camRef.current.z * factor));
    const wx = (sx - camRef.current.ox) / camRef.current.z;
    const wy = (sy - camRef.current.oy) / camRef.current.z;
    camRef.current.z = nextZ;
    camRef.current.ox = sx - wx * nextZ;
    camRef.current.oy = sy - wy * nextZ;
    paintStage();
  };

  return (
    <div className="flex flex-col h-full bg-[#191b1f] border border-[#2b2f36] rounded-xl overflow-hidden">
      {/* Stage Top Utility Bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[#2b2f36] bg-[#141619]">
        <div className="flex items-center gap-1 p-1 bg-[#0e0f11] rounded-lg border border-[#2b2f36]">
          <button
            type="button"
            onClick={() => onRenderModeChange('A')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              renderMode === 'A'
                ? 'bg-[#a855f7] text-white'
                : 'text-[#8b919c] hover:text-[#e6e8ec]'
            }`}
          >
            Cardboard Cutout
          </button>
          <button
            type="button"
            onClick={() => onRenderModeChange('D')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              renderMode === 'D'
                ? 'bg-[#10b981] text-[#0e0f11] font-semibold'
                : 'text-[#8b919c] hover:text-[#e6e8ec]'
            }`}
          >
            Digital X-Ray
          </button>
        </div>

        <div className="flex items-center gap-2 overflow-x-auto">
          <button
            type="button"
            onClick={onToggleBones}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showBones
                ? 'bg-[#10b981]/15 border-[#10b981]/40 text-[#34d399]'
                : 'bg-[#0e0f11] border-[#2b2f36] text-[#8b919c] hover:text-[#e6e8ec]'
            }`}
            title="Toggle green digital bone overlay"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Bones
          </button>
          <button
            type="button"
            onClick={onToggleMotionBlur}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showMotionBlur
                ? 'bg-[#10b981]/15 border-[#10b981]/40 text-[#34d399]'
                : 'bg-[#0e0f11] border-[#2b2f36] text-[#8b919c] hover:text-[#e6e8ec]'
            }`}
            title="Toggle 5-frame fluid wing motion blur trail"
          >
            <Wind className="w-3.5 h-3.5" />
            Blur Trail
          </button>
          <button
            type="button"
            onClick={onToggleAutoZoomFraming}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              autoZoomFraming
                ? 'bg-[#a855f7]/15 border-[#a855f7]/45 text-[#c084fc]'
                : 'bg-[#0e0f11] border-[#2b2f36] text-[#8b919c] hover:text-[#e6e8ec]'
            }`}
            title="Automatically zoom camera to match portrait, bust, or full-figure framing"
          >
            <Focus className="w-3.5 h-3.5" />
            {autoZoomFraming ? FRAMING_BADGE[subjectFraming] : 'Auto-Zoom'}
          </button>
          <button
            type="button"
            onClick={() => {
              fitToStage();
              paintStage();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#2b2f36] bg-[#0e0f11] text-[#8b919c] hover:text-[#e6e8ec] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            title="Fit Bitruvian puppet to stage"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            Fit Rig
          </button>
          <button
            type="button"
            onClick={() => canvasRef.current && onExportPng(canvasRef.current)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#2b2f36] bg-[#0e0f11] text-[#8b919c] hover:text-[#e6e8ec] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            title="Export current puppet frame as PNG"
          >
            <Camera className="w-3.5 h-3.5" />
            PNG
          </button>
        </div>
      </div>

      {/* Main Canvas Stage */}
      <div ref={containerRef} className="relative flex-1 min-h-[420px] bg-[#121315] select-none">
        {rigError ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <div className="max-w-md bg-[#191b1f] border border-[#ff3b6b]/40 rounded-lg p-5">
              <p className="text-sm font-semibold text-[#ff3b6b]">Failed to Load Bitruvian Rig</p>
              <p className="text-xs text-[#8b919c] mt-1">{rigError}</p>
            </div>
          </div>
        ) : !rig ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[#8b919c]">
            Decoding Bitruvian 2500×8742 cardboard cutouts...
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
            className="w-full h-full block cursor-grab active:cursor-grabbing touch-none"
            aria-label="Bitruvian cardboard cutout motion capture stage"
          />
        )}

        {/* Quiet stage hint overlay */}
        {rig && (
          <div className="pointer-events-none absolute left-4 bottom-3 flex items-center gap-2 text-xs text-[#8b919c]">
            <Eye className="w-3.5 h-3.5 text-[#a855f7]" />
            <span>
              Drag any limb while playing or paused
              <span aria-hidden="true"> · </span>
              Scroll to zoom
              {hoveredNodeId && rig.by[hoveredNodeId] ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="text-[#e6e8ec] font-medium">{rig.by[hoveredNodeId].name}</span>
                </>
              ) : null}
            </span>
          </div>
        )}
      </div>

      {/* Bottom Timeline & Playback Bar */}
      <div className="px-4 py-3 border-t border-[#2b2f36] bg-[#141619] flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onStepFrame(-1)}
            disabled={totalFrames === 0}
            className="p-2 rounded-lg border border-[#2b2f36] bg-[#0e0f11] text-[#e6e8ec] hover:border-[#a855f7]/60 disabled:opacity-40 transition-colors cursor-pointer"
            aria-label="Previous frame"
          >
            <SkipBack className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={totalFrames === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#a855f7] hover:bg-[#9333ea] text-white text-xs font-semibold disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            aria-label={isPlaying ? 'Pause playback' : 'Play motion capture'}
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            onClick={() => onStepFrame(1)}
            disabled={totalFrames === 0}
            className="p-2 rounded-lg border border-[#2b2f36] bg-[#0e0f11] text-[#e6e8ec] hover:border-[#a855f7]/60 disabled:opacity-40 transition-colors cursor-pointer"
            aria-label="Next frame"
          >
            <SkipForward className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-w-[180px] flex items-center gap-3">
          <label htmlFor="stage-scrubber" className="sr-only">
            Frame Scrubber
          </label>
          <input
            id="stage-scrubber"
            type="range"
            min={0}
            max={Math.max(0, totalFrames - 1)}
            value={currentFrame}
            onChange={(e) => onScrubFrame(parseInt(e.target.value, 10))}
            disabled={totalFrames === 0}
            className="studio-range w-full"
          />
          <span className="font-mono-tabular text-xs text-[#e6e8ec] whitespace-nowrap shrink-0">
            {totalFrames > 0
              ? `${String(currentFrame + 1).padStart(2, '0')} / ${String(totalFrames).padStart(2, '0')}`
              : '00 / 00'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="fps-select" className="text-xs text-[#8b919c] whitespace-nowrap">
            Cadence
          </label>
          <select
            id="fps-select"
            value={fps}
            onChange={(e) => onFpsChange(Number(e.target.value))}
            className="bg-[#0e0f11] border border-[#2b2f36] rounded-lg px-2.5 py-1.5 text-xs font-mono-tabular text-[#e6e8ec] focus:outline-none focus:border-[#a855f7]"
          >
            <option value={6}>6 fps</option>
            <option value={10}>10 fps</option>
            <option value={12}>12 fps</option>
            <option value={24}>24 fps</option>
          </select>

          <label htmlFor="feel-select" className="text-xs text-[#8b919c] whitespace-nowrap ml-1">
            Feel
          </label>
          <select
            id="feel-select"
            value={motionFeel}
            onChange={(e) => onMotionFeelChange(e.target.value as MotionFeel)}
            className="bg-[#0e0f11] border border-[#2b2f36] rounded-lg px-2.5 py-1.5 text-xs text-[#e6e8ec] focus:outline-none focus:border-[#a855f7]"
          >
            <option value="raw">Raw Mocap</option>
            <option value="flow">Flow Ease</option>
            <option value="snap">Snap Tension</option>
            <option value="elastic">Elastic Recoil</option>
            <option value="mechanical">Mechanical Cam</option>
            <option value="clockwork">Clockwork Step</option>
          </select>
        </div>
      </div>
    </div>
  );
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CapturePanel } from './components/CapturePanel';
import { ExportPanel } from './components/ExportPanel';
import { PuppetStage, type RigRuntime } from './components/PuppetStage';
import { RetargetPanel } from './components/RetargetPanel';
import { parseMotionDataset } from './engine/datasetImporter';
import {
  applyPoseSnapshot,
  buildRigGraph,
  clampAnatomicalAngle,
  decImage,
  exportBskJson,
  getBondStatus,
  getTensionRatio,
  setPieceBitmap,
  solveRig,
} from './engine/fkEngine';
import { PERSP_DEFAULT } from './engine/ikEngine';
import {
  advanceLoopCleanupPass,
  createLoopLearnerState,
  recordLivePoseEdit,
} from './engine/loopLearner';
import {
  classifySubjectFraming,
  computeClipReference,
  computeSegmentalCoM,
  pickPrimarySubject,
  retargetCocoToBitruvian,
  smoothMocapFrames,
} from './engine/mocapRetargeter';
import { BITRUVIAN_MOCAP_ROADMAP } from './engine/rigMetadata';
import { SAMPLE_MOTION_CLIPS, type SampleMotionClip } from './engine/sampleMotions';
import type {
  BondStatusItem,
  CoMPoint,
  Keyframe,
  LoopLearnerState,
  MotionFeel,
  PerspectiveState,
  PoseSnapshot,
  RawRigDef,
  RenderMode,
  RetargetFrameResult,
  RetargetOptions,
  SubjectFraming,
} from './engine/types';
import { analyzeFrameForSkeletons } from './services/geminiService';
import type { Person } from './types';

type DeckTab = 'capture' | 'retarget' | 'export' | 'roadmap';

function evalMotionCurve(u: number, feel: MotionFeel): number {
  const t = Math.max(0, Math.min(1, u));
  switch (feel) {
    case 'raw':
      return t;
    case 'flow':
      return 0.5 - 0.5 * Math.cos(Math.PI * t);
    case 'snap':
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'elastic': {
      if (t === 0 || t === 1) return t;
      return Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    }
    case 'mechanical': {
      const steps = 4;
      const idx = Math.floor(t * steps);
      const local = t * steps - idx;
      const crisp = local < 0.35 ? local / 0.35 : 1;
      return Math.min(1, (idx + crisp) / steps);
    }
    case 'clockwork': {
      const teeth = 6;
      const idx = Math.floor(t * teeth);
      const local = t * teeth - idx;
      const pawl = Math.pow(local, 2.2);
      return Math.min(1, (idx + pawl) / teeth);
    }
    default:
      return t;
  }
}

const App: React.FC = () => {
  const [rig, setRig] = useState<RigRuntime | null>(null);
  const [rigError, setRigError] = useState<string | null>(null);

  // Motion source, media & dataset state
  const [activeSourceId, setActiveSourceId] = useState<string>(SAMPLE_MOTION_CLIPS[0].id);
  const [rawFrames, setRawFrames] = useState<Person[][]>(SAMPLE_MOTION_CLIPS[0].frames);
  const [bskFramesOverride, setBskFramesOverride] = useState<PoseSnapshot[] | null>(null);
  const [mediaKind, setMediaKind] = useState<'none' | 'video' | 'photo'>('none');
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [sampleFps, setSampleFps] = useState<number>(6);
  const [maxFrames, setMaxFrames] = useState<number>(24);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processingProgress, setProcessingProgress] = useState<string>('');
  const [progressRatio, setProgressRatio] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [datasetSummary, setDatasetSummary] = useState<string | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Playback & stage state
  const [deckTab, setDeckTab] = useState<DeckTab>('capture');
  const [currentFrame, setCurrentFrame] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [fps, setFps] = useState<number>(SAMPLE_MOTION_CLIPS[0].fps);
  const [motionFeel, setMotionFeel] = useState<MotionFeel>('flow');
  const [renderMode, setRenderMode] = useState<RenderMode>('A');
  const [showBones, setShowBones] = useState<boolean>(true);
  const [showGuides, setShowGuides] = useState<boolean>(false);
  const [showJointPins, setShowJointPins] = useState<boolean>(true);
  const [showMotionBlur, setShowMotionBlur] = useState<boolean>(true);
  const [showCoM, setShowCoM] = useState<boolean>(true);
  const [showCocoOverlay, setShowCocoOverlay] = useState<boolean>(true);
  const [autoZoomFraming, setAutoZoomFraming] = useState<boolean>(true);
  const [framingNonce, setFramingNonce] = useState<number>(0);
  const [persp, setPersp] = useState<PerspectiveState>(PERSP_DEFAULT);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [renderTick, setRenderTick] = useState<number>(0);

  // Retargeting options with Lotte Reiniger shoulder poise & cyclic loop learning on by default
  const [retargetOptions, setRetargetOptions] = useState<RetargetOptions>({
    solverMode: 'ik-analytical',
    constrainLimits: true,
    bondOn: true,
    groundLock: true,
    groundY: PERSP_DEFAULT.groundY,
    mirrorHorizontal: false,
    smoothing: 0.35,
    torsoScale: 1.0,
    shoulderPoise: 0.85,
    loopLearning: true,
  });

  // Refs synced for lock-free playback + live posing without rAF restarts
  const currentFrameRef = useRef<number>(0);
  currentFrameRef.current = currentFrame;
  const motionFeelRef = useRef<MotionFeel>(motionFeel);
  motionFeelRef.current = motionFeel;
  const retargetOptionsRef = useRef<RetargetOptions>(retargetOptions);
  retargetOptionsRef.current = retargetOptions;

  // Live telemetry
  const [bondStrain, setBondStrain] = useState<BondStatusItem[]>([]);
  const [clampedNodes, setClampedNodes] = useState<string[]>([]);
  const [subjectConfidence, setSubjectConfidence] = useState<number>(1);

  useEffect(() => {
    setRetargetOptions((prev) =>
      prev.groundY === persp.groundY ? prev : { ...prev, groundY: persp.groundY },
    );
  }, [persp.groundY]);

  useEffect(() => {
    return () => {
      if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl);
    };
  }, [mediaPreviewUrl]);

  // Load Bitruvian cardboard cutout rig from /rig-data.json
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/rig-data.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { rig: RawRigDef };
        const graph = buildRigGraph(json.rig, true);

        await Promise.all(
          graph.pieces.map(async (piece) => {
            if (!piece.src) return;
            const bm = await decImage(piece.src);
            setPieceBitmap(piece, bm);
          }),
        );

        if (cancelled) return;
        solveRig(graph.nodes, graph.by, true, 0);
        setRig(graph);
      } catch (err) {
        if (!cancelled) {
          setRigError(err instanceof Error ? err.message : 'Unable to load rig-data.json');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Normalize multi-person detections to the single clearest subject before temporal smoothing
  const primaryFrames = useMemo(
    () =>
      rawFrames.map((frame) => {
        const p = pickPrimarySubject(frame);
        return p ? [p] : [];
      }),
    [rawFrames],
  );

  const detectedFraming = useMemo<SubjectFraming>(
    () => (bskFramesOverride ? 'full-figure' : classifySubjectFraming(primaryFrames)),
    [bskFramesOverride, primaryFrames],
  );

  const smoothedFrames = useMemo(
    () => smoothMocapFrames(primaryFrames, retargetOptions.smoothing),
    [primaryFrames, retargetOptions.smoothing],
  );

  // Base retargeted clip before cyclic loop learning & live user posing
  const baseSolvedFrames = useMemo<RetargetFrameResult[]>(() => {
    if (!rig) return [];

    if (bskFramesOverride && bskFramesOverride.length > 0) {
      return bskFramesOverride.map((snap) => {
        applyPoseSnapshot(snap, rig.nodes, rig.by, rig.root, retargetOptions.bondOn);
        return {
          pose: { ...snap.pose },
          root: [snap.root[0], snap.root[1]],
          bondStrain: getBondStatus(rig.nodes, retargetOptions.bondOn),
          clampedNodes: [],
          subjectConfidence: 1,
          com: computeSegmentalCoM(rig.by),
        };
      });
    }

    if (!smoothedFrames.length) return [];
    const clipRef = computeClipReference(smoothedFrames, retargetOptions.mirrorHorizontal);
    return smoothedFrames.map((frame) =>
      retargetCocoToBitruvian(
        frame?.[0] ?? null,
        rig.nodes,
        rig.by,
        rig.root,
        clipRef,
        retargetOptions,
      ),
    );
  }, [rig, bskFramesOverride, smoothedFrames, retargetOptions]);

  // Cyclic loop learner state
  const [loopState, setLoopState] = useState<LoopLearnerState>(() => createLoopLearnerState([]));
  const loopStateRef = useRef<LoopLearnerState>(loopState);

  const commitLoopState = useCallback((next: LoopLearnerState) => {
    loopStateRef.current = next;
    setLoopState(next);
  }, []);

  useEffect(() => {
    const next = createLoopLearnerState(baseSolvedFrames);
    commitLoopState(next);
    setFramingNonce((n) => n + 1);
  }, [baseSolvedFrames, commitLoopState]);

  const solvedClip = loopState.refinedFrames;

  // Apply frame onto rig using ref-backed refinedFrames so edits/loop passes never tear down rAF
  const applySolvedFrame = useCallback(
    (frameIdx: number, subAlpha = 0) => {
      const frames = loopStateRef.current.refinedFrames;
      if (!rig || !frames.length) return;
      const count = frames.length;
      const i0 = ((frameIdx % count) + count) % count;
      const i1 = (i0 + 1) % count;
      const a = frames[i0];
      const b = frames[i1];
      const feel = motionFeelRef.current;
      const bondOn = retargetOptionsRef.current.bondOn;

      if (subAlpha <= 0.001 || feel === 'raw' || count === 1) {
        for (const n of rig.nodes) {
          n.ang = a.pose[n.id] ?? 0;
        }
        rig.root.tx = a.root[0];
        rig.root.ty = a.root[1];
      } else {
        const w = evalMotionCurve(subAlpha, feel);
        for (const n of rig.nodes) {
          const v0 = a.pose[n.id] ?? 0;
          const v1 = b.pose[n.id] ?? 0;
          n.ang = v0 + (v1 - v0) * w;
        }
        rig.root.tx = a.root[0] + (b.root[0] - a.root[0]) * w;
        rig.root.ty = a.root[1] + (b.root[1] - a.root[1]) * w;
      }

      solveRig(rig.nodes, rig.by, bondOn, 0);
      setBondStrain(a.bondStrain);
      setClampedNodes(a.clampedNodes);
      setSubjectConfidence(a.subjectConfidence);
      setRenderTick((t) => t + 1);
    },
    [rig],
  );

  // Sync rig immediately when paused, scrubbing, or single-frame photo changes
  useEffect(() => {
    if (!isPlaying) {
      applySolvedFrame(currentFrame, 0);
    }
  }, [currentFrame, isPlaying, solvedClip, applySolvedFrame]);

  // Smooth playback loop with automatic cyclic loop-pass learning on wrap
  const playStateRef = useRef({
    frame: 0,
    startTime: 0,
    lastLoops: 0,
  });

  useEffect(() => {
    const clipLen = solvedClip.length;
    if (!isPlaying || clipLen <= 1) return;

    playStateRef.current.frame = currentFrameRef.current;
    playStateRef.current.startTime = performance.now();
    playStateRef.current.lastLoops = 0;
    let rafId = 0;

    const tick = (now: number) => {
      const len = loopStateRef.current.refinedFrames.length;
      if (len <= 1) return;
      const elapsedSec = (now - playStateRef.current.startTime) / 1000;
      const totalFloat = elapsedSec * fps;
      const wholeSteps = Math.floor(totalFloat);
      const frac = totalFloat - wholeSteps;
      const totalPosition = playStateRef.current.frame + wholeSteps;
      const targetIdx = totalPosition % len;
      const completedLoops = Math.floor(totalPosition / len);

      if (completedLoops > playStateRef.current.lastLoops) {
        playStateRef.current.lastLoops = completedLoops;
        if (retargetOptionsRef.current.loopLearning && rig) {
          const cleaned = advanceLoopCleanupPass(
            loopStateRef.current,
            rig.nodes,
            rig.by,
            rig.root,
            retargetOptionsRef.current,
          );
          commitLoopState(cleaned);
        }
      }

      setCurrentFrame(targetIdx);
      applySolvedFrame(targetIdx, frac);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, fps, solvedClip.length, rig, applySolvedFrame, commitLoopState]);

  // Photo analysis helper (supports tight portraits, close-ups, upper-body, and full figures)
  const analyzePhotoFile = useCallback(async (file: File) => {
    setIsProcessing(true);
    setIsPlaying(false);
    setError(null);
    setProcessingProgress('Reading photo resolution...');
    setProgressRatio(0.2);

    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Could not decode image file.'));
        el.src = objectUrl;
      });

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not create canvas context.');

      // Preserve crisp facial & shoulder landmark detail for close-ups and portraits
      const maxDim = 1280;
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];

      setProcessingProgress('Detecting figure & facial parts...');
      setProgressRatio(0.65);

      const people = await analyzeFrameForSkeletons(base64, 'image/jpeg');
      const primary = pickPrimarySubject(people);
      if (!primary) {
        setError('No recognizable human figure or face was detected in this photo.');
        setIsProcessing(false);
        setProcessingProgress('');
        return;
      }

      setBskFramesOverride(null);
      setDatasetSummary(null);
      setDatasetError(null);
      setActiveSourceId('photo');
      setRawFrames([[primary]]);
      setCurrentFrame(0);
      setIsPlaying(false);
      setAutoZoomFraming(true);
      setFramingNonce((n) => n + 1);
      setProgressRatio(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      URL.revokeObjectURL(objectUrl);
      setIsProcessing(false);
      setProcessingProgress('');
    }
  }, []);

  const handleSelectSampleClip = (clip: SampleMotionClip) => {
    setBskFramesOverride(null);
    setDatasetSummary(null);
    setDatasetError(null);
    setActiveSourceId(clip.id);
    setRawFrames(clip.frames);
    setFps(clip.fps);
    setCurrentFrame(0);
    setIsPlaying(true);
    setError(null);
    setFramingNonce((n) => n + 1);
  };

  const handleMediaSelect = (file: File) => {
    if (mediaPreviewUrl) URL.revokeObjectURL(mediaPreviewUrl);
    const nextUrl = URL.createObjectURL(file);
    setMediaFile(file);
    setMediaPreviewUrl(nextUrl);
    setError(null);

    if (file.type.startsWith('image/')) {
      setMediaKind('photo');
      void analyzePhotoFile(file);
    } else {
      setMediaKind('video');
    }
  };

  const handleAnalyzeVideo = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.duration) {
      setError('Video metadata is still loading. Wait a moment and try again.');
      return;
    }

    setIsProcessing(true);
    setIsPlaying(false);
    setError(null);
    setProgressRatio(0);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setError('Could not initialize canvas for video frame capture.');
      setIsProcessing(false);
      return;
    }

    const duration = video.duration;
    const totalCandidate = Math.max(1, Math.floor(duration * sampleFps));
    const framesToProcess = Math.min(maxFrames, totalCandidate);
    const frameInterval = duration / framesToProcess;
    const captured: Person[][] = [];

    video.pause();

    const seekAndCapture = (index: number): Promise<string> =>
      new Promise((resolve) => {
        video.onseeked = () => {
          video.onseeked = null;
          const maxDim = 960;
          const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
          resolve(dataUrl.split(',')[1]);
        };
        video.currentTime = Math.min(duration - 0.02, index * frameInterval);
      });

    for (let i = 0; i < framesToProcess; i++) {
      setProcessingProgress(`Analyzing frame ${i + 1} of ${framesToProcess}`);
      setProgressRatio((i + 0.25) / framesToProcess);

      const base64 = await seekAndCapture(i);
      let retries = 0;
      let done = false;
      while (!done) {
        try {
          const people = await analyzeFrameForSkeletons(base64, 'image/jpeg');
          const primary = pickPrimarySubject(people);
          captured.push(primary ? [primary] : []);
          done = true;
          setProgressRatio((i + 1) / framesToProcess);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Rate limit') && retries < 2) {
            retries += 1;
            setProcessingProgress(`Rate limit reached — pausing 15s before retry (${retries}/2)...`);
            await new Promise((r) => setTimeout(r, 15000));
          } else {
            setError(`Stopped on frame ${i + 1}: ${msg}`);
            setIsProcessing(false);
            setProcessingProgress('');
            return;
          }
        }
      }
    }

    const hasSubject = captured.some((f) => f.length > 0);
    if (!hasSubject) {
      setError('No recognizable human figure was detected in the sampled frames.');
      setIsProcessing(false);
      setProcessingProgress('');
      return;
    }

    setBskFramesOverride(null);
    setDatasetSummary(null);
    setDatasetError(null);
    setActiveSourceId('video');
    setRawFrames(captured);
    setFps(sampleFps);
    setCurrentFrame(0);
    setIsProcessing(false);
    setProcessingProgress('');
    setProgressRatio(1);
    setIsPlaying(captured.length > 1);
    setFramingNonce((n) => n + 1);
  }, [sampleFps, maxFrames]);

  const handleAnalyzeMedia = useCallback(() => {
    if (mediaKind === 'photo' && mediaFile) {
      void analyzePhotoFile(mediaFile);
    } else if (mediaKind === 'video') {
      void handleAnalyzeVideo();
    }
  }, [mediaKind, mediaFile, analyzePhotoFile, handleAnalyzeVideo]);

  const handleImportDatasetText = useCallback(
    (rawText: string, fileName: string) => {
      if (!rig) return;
      setDatasetError(null);
      try {
        const parsed = parseMotionDataset(rawText, rig.nodes, fileName);
        if (parsed.kind === 'bsk') {
          setBskFramesOverride(parsed.keyframes);
          setRawFrames([]);
          setIsPlaying(parsed.keyframes.length > 1);
        } else {
          setBskFramesOverride(null);
          setRawFrames(parsed.frames);
          setIsPlaying(parsed.frames.length > 1);
        }
        setActiveSourceId('dataset');
        setDatasetSummary(`${parsed.label}: ${parsed.summary}`);
        setCurrentFrame(0);
        setFps(10);
        setFramingNonce((n) => n + 1);
      } catch (err) {
        setDatasetError(err instanceof Error ? err.message : 'Unable to parse dataset JSON.');
      }
    },
    [rig],
  );

  // Live posing while moving OR paused — never forces pause!
  const handleLivePose = useCallback(
    (
      activeNodeIds: string[],
      pose: Record<string, number>,
      rootPos: [number, number],
      isFinal: boolean,
    ) => {
      if (!rig || activeNodeIds.length === 0) return;
      const next = recordLivePoseEdit(
        loopStateRef.current,
        currentFrameRef.current,
        activeNodeIds,
        pose,
        activeNodeIds.includes('pelvis') ? rootPos : null,
        rig.nodes,
        rig.by,
        rig.root,
        retargetOptionsRef.current,
        isFinal,
      );
      commitLoopState(next);
      setRenderTick((t) => t + 1);
    },
    [rig, commitLoopState],
  );

  const handleUpdateNodeAngle = (nodeId: string, angle: number) => {
    if (!rig || !rig.by[nodeId]) return;
    rig.by[nodeId].ang = angle;
    solveRig(rig.nodes, rig.by, retargetOptions.bondOn, 0);
    const pose = Object.fromEntries(rig.nodes.map((n) => [n.id, Math.round(n.ang * 100) / 100]));
    const next = recordLivePoseEdit(
      loopStateRef.current,
      currentFrame,
      [nodeId],
      pose,
      null,
      rig.nodes,
      rig.by,
      rig.root,
      retargetOptions,
      true,
    );
    commitLoopState(next);
    setRenderTick((t) => t + 1);
  };

  const handleToggleFlipX = (nodeId: string) => {
    if (!rig || !rig.by[nodeId]) return;
    rig.by[nodeId].flipX = !rig.by[nodeId].flipX;
    solveRig(rig.nodes, rig.by, retargetOptions.bondOn, 0);
    setRenderTick((t) => t + 1);
  };

  const handleClearCurrentFrameEdit = () => {
    if (!rig) return;
    const state = loopStateRef.current;
    const base = state.baseFrames[currentFrame];
    if (!base) return;

    const frameDeltas = state.frameDeltas.map((d, i) => (i === currentFrame ? {} : { ...d }));
    const rootDeltas = state.rootDeltas.map((r, i) =>
      i === currentFrame ? ([0, 0] as [number, number]) : ([r[0], r[1]] as [number, number]),
    );
    const nextPose: Record<string, number> = {};
    const clamped: string[] = [];

    for (const node of rig.nodes) {
      const val = (base.pose[node.id] ?? 0) + (state.postureBias[node.id] ?? 0);
      node.ang = clampAnatomicalAngle(node, val, retargetOptions.constrainLimits);
      nextPose[node.id] = Math.round(node.ang * 100) / 100;
      const t = getTensionRatio(node);
      if (t.atLimit || t.nearLimit) clamped.push(node.id);
    }
    rig.root.tx = base.root[0];
    rig.root.ty = base.root[1];
    solveRig(rig.nodes, rig.by, retargetOptions.bondOn, 0);

    const refinedFrames = state.refinedFrames.map((f, i) =>
      i === currentFrame
        ? {
            pose: nextPose,
            root: [rig.root.tx, rig.root.ty] as [number, number],
            bondStrain: getBondStatus(rig.nodes, retargetOptions.bondOn),
            clampedNodes: clamped,
            subjectConfidence: base.subjectConfidence,
            com: computeSegmentalCoM(rig.by),
          }
        : f,
    );

    commitLoopState({
      ...state,
      frameDeltas,
      rootDeltas,
      refinedFrames,
      editedFrameCount: frameDeltas.filter((d) => Object.keys(d).length > 0).length,
    });
    setRenderTick((t) => t + 1);
  };

  const handleRunCleanupPass = () => {
    if (!rig || loopStateRef.current.refinedFrames.length < 4) return;
    const next = advanceLoopCleanupPass(
      loopStateRef.current,
      rig.nodes,
      rig.by,
      rig.root,
      retargetOptions,
    );
    commitLoopState(next);
    setRenderTick((t) => t + 1);
  };

  const handleResetLoopLearner = () => {
    const fresh = createLoopLearnerState(baseSolvedFrames);
    commitLoopState(fresh);
    setRenderTick((t) => t + 1);
  };

  const handleExportBsk = () => {
    if (!rig || !solvedClip.length) return;
    const keyframes: Keyframe[] = solvedClip.map((res, idx) => ({
      f: idx,
      a: rig.nodes.map((n) => res.pose[n.id] ?? 0),
      x: res.root[0],
      y: res.root[1],
    }));
    const payload = exportBskJson(rig.nodes, rig.by, rig.W, rig.H, keyframes);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bitruvian-mocap-${activeSourceId}.bsk.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCocoJson = () => {
    if (!smoothedFrames.length) return;
    const blob = new Blob([JSON.stringify(smoothedFrames, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coco-mocap-${activeSourceId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPng = (canvas: HTMLCanvasElement) => {
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `bitruvian-frame-${String(currentFrame + 1).padStart(3, '0')}.png`;
    a.click();
  };

  const currentCocoPerson = smoothedFrames[currentFrame]?.[0] ?? null;

  const trailPoses: PoseSnapshot[] = useMemo(() => {
    const n = solvedClip.length;
    if (n <= 1) return [];
    const windowSize = Math.min(5, n - 1);
    const list: PoseSnapshot[] = [];
    for (let offset = windowSize; offset >= 1; offset--) {
      const idx = isPlaying
        ? (currentFrame - offset + n) % n
        : currentFrame - offset;
      if (idx >= 0 && idx < n && solvedClip[idx]) {
        list.push({
          pose: solvedClip[idx].pose,
          root: solvedClip[idx].root,
        });
      }
    }
    return list;
  }, [currentFrame, solvedClip, isPlaying]);

  const comTrail: CoMPoint[] = useMemo(() => {
    const n = solvedClip.length;
    if (!n) return [];
    const windowSize = Math.min(14, n);
    const pts: CoMPoint[] = [];
    for (let offset = windowSize - 1; offset >= 0; offset--) {
      const idx = currentFrame - offset;
      if (idx >= 0 && idx < n && solvedClip[idx]) {
        pts.push(solvedClip[idx].com);
      }
    }
    return pts;
  }, [currentFrame, solvedClip]);

  const currentCom: CoMPoint | null = solvedClip[currentFrame]?.com ?? null;
  const selectedNode = rig && selectedNodeId ? rig.by[selectedNodeId] ?? null : null;

  const currentFrameHasEdit =
    Object.keys(loopState.frameDeltas[currentFrame] ?? {}).length > 0 ||
    Math.abs(loopState.rootDeltas[currentFrame]?.[0] ?? 0) > 0.1 ||
    Math.abs(loopState.rootDeltas[currentFrame]?.[1] ?? 0) > 0.1;

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-[#121315] text-[#e6e8ec]">
      {/* Strict 3-Zone Top Bar */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-[#2b2f36] bg-[#141619] shrink-0">
        <a
          href="/"
          className="text-base font-bold tracking-tight text-[#e6e8ec] whitespace-nowrap shrink-0"
        >
          Bitruvian Mocap
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-[#8b919c]">
          {(
            [
              ['capture', 'Sources'],
              ['retarget', 'Retarget'],
              ['export', 'Rig & Export'],
              ['roadmap', 'Architecture'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setDeckTab(id)}
              className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer pb-0.5 border-b-2 ${
                deckTab === id
                  ? 'text-[#e6e8ec] border-[#a855f7]'
                  : 'border-transparent hover:text-[#e6e8ec]'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={handleExportBsk}
            disabled={solvedClip.length === 0}
            className="px-4 py-2 text-xs font-semibold text-white bg-[#a855f7] hover:bg-[#9333ea] rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 cursor-pointer"
          >
            Export .bsk
          </button>
        </div>
      </header>

      {/* Main Two-Zone Studio Workspace */}
      <main className="flex-1 min-h-0 max-w-[1600px] w-full mx-auto p-4 lg:p-5 grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left/Center Dominant Stage (8 cols ~ 66%) */}
        <section className="lg:col-span-8 min-h-[540px] lg:min-h-0 flex flex-col">
          <PuppetStage
            rig={rig}
            rigError={rigError}
            currentFrame={currentFrame}
            totalFrames={solvedClip.length}
            isPlaying={isPlaying}
            fps={fps}
            motionFeel={motionFeel}
            renderMode={renderMode}
            showBones={showBones}
            showGuides={showGuides}
            showJointPins={showJointPins}
            constrainLimits={retargetOptions.constrainLimits}
            bondOn={retargetOptions.bondOn}
            showMotionBlur={showMotionBlur}
            showCoM={showCoM}
            showCocoOverlay={showCocoOverlay}
            mirrorHorizontal={retargetOptions.mirrorHorizontal}
            solverMode={retargetOptions.solverMode}
            persp={persp}
            selectedNodeId={selectedNodeId}
            currentCocoFrame={currentCocoPerson}
            trailPoses={trailPoses}
            comTrail={comTrail}
            currentCom={currentCom}
            renderTick={renderTick}
            subjectFraming={detectedFraming}
            autoZoomFraming={autoZoomFraming}
            framingNonce={framingNonce}
            onToggleAutoZoomFraming={() => setAutoZoomFraming((v) => !v)}
            onSelectNode={setSelectedNodeId}
            onLivePose={handleLivePose}
            onPerspChange={setPersp}
            onTogglePlay={() => setIsPlaying((p) => !p)}
            onStepFrame={(delta) => {
              setIsPlaying(false);
              setCurrentFrame((f) =>
                solvedClip.length ? (f + delta + solvedClip.length) % solvedClip.length : 0,
              );
            }}
            onScrubFrame={(idx) => {
              setIsPlaying(false);
              setCurrentFrame(idx);
            }}
            onFpsChange={setFps}
            onMotionFeelChange={setMotionFeel}
            onRenderModeChange={setRenderMode}
            onToggleBones={() => setShowBones((b) => !b)}
            onToggleMotionBlur={() => setShowMotionBlur((o) => !o)}
            onExportPng={handleExportPng}
          />
        </section>

        {/* Right Control & Telemetry Deck (4 cols ~ 34%) */}
        <aside className="lg:col-span-4 min-h-0 flex flex-col bg-[#191b1f] border border-[#2b2f36] rounded-xl overflow-hidden">
          {/* Mobile/Compact Deck Tabs */}
          <div className="flex items-center gap-1 p-2 border-b border-[#2b2f36] bg-[#141619] md:hidden">
            {(
              [
                ['capture', 'Sources'],
                ['retarget', 'Retarget'],
                ['export', 'Export'],
                ['roadmap', 'Arch'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setDeckTab(id)}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  deckTab === id ? 'bg-[#a855f7] text-white' : 'text-[#8b919c]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="px-4 py-3 border-b border-[#2b2f36] flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#e6e8ec]">
              {deckTab === 'capture' && 'Motion & Photo Sources'}
              {deckTab === 'retarget' && 'Cardboard Rig & Loop Learner'}
              {deckTab === 'export' && 'Live Posing & Export'}
              {deckTab === 'roadmap' && 'Bitruvian Mocap Architecture'}
            </h2>
            <span className="font-mono-tabular text-xs text-[#8b919c]">
              {solvedClip.length} {solvedClip.length === 1 ? 'frame' : 'frames'}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {deckTab === 'capture' && (
              <CapturePanel
                sampleClips={SAMPLE_MOTION_CLIPS}
                activeSourceId={activeSourceId}
                onSelectSampleClip={handleSelectSampleClip}
                mediaKind={mediaKind}
                mediaPreviewUrl={mediaPreviewUrl}
                videoRef={videoRef}
                isProcessing={isProcessing}
                processingProgress={processingProgress}
                progressRatio={progressRatio}
                error={error}
                sampleFps={sampleFps}
                maxFrames={maxFrames}
                onSampleFpsChange={setSampleFps}
                onMaxFramesChange={setMaxFrames}
                onMediaSelect={handleMediaSelect}
                onAnalyzeMedia={handleAnalyzeMedia}
                onImportDatasetText={handleImportDatasetText}
                datasetSummary={datasetSummary}
                datasetError={datasetError}
                currentCocoFrame={currentCocoPerson}
                mirrorHorizontal={retargetOptions.mirrorHorizontal}
                detectedFraming={detectedFraming}
              />
            )}

            {deckTab === 'retarget' && (
              <RetargetPanel
                options={retargetOptions}
                onOptionsChange={setRetargetOptions}
                showJointPins={showJointPins}
                showCoM={showCoM}
                showGuides={showGuides}
                perspEnabled={persp.enabled}
                showCocoOverlay={showCocoOverlay}
                onToggleJointPins={() => setShowJointPins((v) => !v)}
                onToggleCoM={() => setShowCoM((v) => !v)}
                onToggleGuides={() => setShowGuides((v) => !v)}
                onTogglePersp={() => setPersp((p) => ({ ...p, enabled: !p.enabled }))}
                onToggleCocoOverlay={() => setShowCocoOverlay((v) => !v)}
                bondStrain={bondStrain}
                clampedNodes={clampedNodes}
                subjectConfidence={subjectConfidence}
                currentCom={currentCom}
                loopPass={loopState.loopPass}
                learnedEditCount={loopState.editedFrameCount}
                onRunCleanupPass={handleRunCleanupPass}
                onResetLoopLearner={handleResetLoopLearner}
              />
            )}

            {deckTab === 'export' && (
              <ExportPanel
                selectedNode={selectedNode}
                hasFrameOverride={currentFrameHasEdit}
                overrideCount={loopState.editedFrameCount}
                totalFrames={solvedClip.length}
                onUpdateNodeAngle={handleUpdateNodeAngle}
                onToggleFlipX={handleToggleFlipX}
                onClearFrameOverride={handleClearCurrentFrameEdit}
                onClearAllOverrides={handleResetLoopLearner}
                onExportBsk={handleExportBsk}
                onExportCocoJson={handleExportCocoJson}
              />
            )}

            {deckTab === 'roadmap' && (
              <div className="space-y-4">
                <p className="text-xs text-[#8b919c]">
                  Guided by the Bitruvian Human Puppyt architecture: deterministic 2500×8742 cardboard cutout hierarchy, Lotte Reiniger shoulder poise, and cyclic loop learning.
                </p>
                <div className="space-y-3">
                  {BITRUVIAN_MOCAP_ROADMAP.map((item) => (
                    <div
                      key={item.phase}
                      className="p-3.5 rounded-lg bg-[#0e0f11] border border-[#2b2f36] space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono-tabular font-semibold text-[#c084fc]">
                          {item.phase}
                        </span>
                        <span
                          className={`text-[11px] font-medium ${
                            item.status === 'active' ? 'text-[#34d399]' : 'text-[#8b919c]'
                          }`}
                        >
                          {item.status === 'active' ? '● LIVE IN RIG' : '● INTEGRATED'}
                        </span>
                      </div>
                      <h4 className="text-sm font-semibold text-[#e6e8ec]">{item.title}</h4>
                      <p className="text-xs text-[#8b919c]">{item.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
};

export default App;

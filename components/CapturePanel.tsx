import React, { useEffect, useRef, useState } from 'react';
import { Database, FileJson, Film, Image as ImageIcon, Play, Upload } from 'lucide-react';
import { SKELETON_CONNECTIONS } from '../constants';
import type { SampleMotionClip } from '../engine/sampleMotions';
import type { SubjectFraming } from '../engine/types';
import type { Person } from '../types';

interface CapturePanelProps {
  sampleClips: SampleMotionClip[];
  activeSourceId: string;
  onSelectSampleClip: (clip: SampleMotionClip) => void;
  mediaKind: 'none' | 'video' | 'photo';
  mediaPreviewUrl: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isProcessing: boolean;
  processingProgress: string;
  progressRatio: number;
  error: string | null;
  sampleFps: number;
  maxFrames: number;
  onSampleFpsChange: (fps: number) => void;
  onMaxFramesChange: (maxFrames: number) => void;
  onMediaSelect: (file: File) => void;
  onAnalyzeMedia: () => void;
  onImportDatasetText: (rawText: string, fileName: string) => void;
  datasetSummary: string | null;
  datasetError: string | null;
  currentCocoFrame: Person | null;
  mirrorHorizontal: boolean;
  detectedFraming: SubjectFraming;
}

const FRAMING_LABELS: Record<SubjectFraming, string> = {
  'full-figure': 'Full Figure',
  'upper-body': 'Upper Body Crop',
  'portrait-bust': 'Bust Portrait',
  'closeup-head': 'Head Close-up',
};

export const CapturePanel: React.FC<CapturePanelProps> = ({
  sampleClips,
  activeSourceId,
  onSelectSampleClip,
  mediaKind,
  mediaPreviewUrl,
  videoRef,
  isProcessing,
  processingProgress,
  progressRatio,
  error,
  sampleFps,
  maxFrames,
  onSampleFpsChange,
  onMaxFramesChange,
  onMediaSelect,
  onAnalyzeMedia,
  onImportDatasetText,
  datasetSummary,
  datasetError,
  currentCocoFrame,
  mirrorHorizontal,
  detectedFraming,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const datasetInputRef = useRef<HTMLInputElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const photoImgRef = useRef<HTMLImageElement>(null);

  const [inputMode, setInputMode] = useState<'presets' | 'media' | 'dataset'>('presets');
  const [pastedJson, setPastedJson] = useState<string>('');
  const [showPasteBox, setShowPasteBox] = useState<boolean>(false);

  // Sync COCO keypoint overlay onto active video or still photo preview
  useEffect(() => {
    const cv = overlayCanvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, cv.width, cv.height);
    const isMediaActive = activeSourceId === 'video' || activeSourceId === 'photo';
    if (!currentCocoFrame || !isMediaActive) return;

    // Fit normalized [0..1] image coordinates into object-contain preview box
    let drawW = cv.width;
    let drawH = cv.height;
    let offX = 0;
    let offY = 0;

    if (mediaKind === 'photo' && photoImgRef.current && photoImgRef.current.naturalWidth > 0) {
      const natW = photoImgRef.current.naturalWidth;
      const natH = photoImgRef.current.naturalHeight;
      const s = Math.min(cv.width / natW, cv.height / natH);
      drawW = natW * s;
      drawH = natH * s;
      offX = (cv.width - drawW) * 0.5;
      offY = (cv.height - drawH) * 0.5;
    } else if (mediaKind === 'video' && videoRef.current && videoRef.current.videoWidth > 0) {
      const natW = videoRef.current.videoWidth;
      const natH = videoRef.current.videoHeight;
      const s = Math.min(cv.width / natW, cv.height / natH);
      drawW = natW * s;
      drawH = natH * s;
      offX = (cv.width - drawW) * 0.5;
      offY = (cv.height - drawH) * 0.5;
    }

    const kp = currentCocoFrame.keypoints;
    const mapPt = (pt: { x: number; y: number } | null): [number, number] | null => {
      if (!pt) return null;
      const nx = mirrorHorizontal ? 1 - pt.x : pt.x;
      return [offX + nx * drawW, offY + pt.y * drawH];
    };

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [aKey, bKey] of SKELETON_CONNECTIONS) {
      const a = mapPt(kp[aKey]);
      const b = mapPt(kp[bKey]);
      if (a && b) {
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
    }
    ctx.stroke();

    ctx.fillStyle = '#22c55e';
    for (const pt of Object.values(kp)) {
      const p = mapPt(pt);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [currentCocoFrame, activeSourceId, mirrorHorizontal, mediaKind, videoRef, mediaPreviewUrl]);

  const handleDatasetFile = async (file: File) => {
    const text = await file.text();
    onImportDatasetText(text, file.name);
  };

  return (
    <div className="space-y-5">
      {/* Capture Source Mode Tabs */}
      <div className="grid grid-cols-3 gap-1 p-1 bg-[#0e0f11] rounded-lg border border-[#2b2f36]">
        <button
          type="button"
          onClick={() => setInputMode('presets')}
          className={`py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
            inputMode === 'presets'
              ? 'bg-[#2b2f36] text-[#e6e8ec]'
              : 'text-[#8b919c] hover:text-[#e6e8ec]'
          }`}
        >
          Muybridge
        </button>
        <button
          type="button"
          onClick={() => setInputMode('media')}
          className={`py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
            inputMode === 'media'
              ? 'bg-[#2b2f36] text-[#e6e8ec]'
              : 'text-[#8b919c] hover:text-[#e6e8ec]'
          }`}
        >
          Photo / Video
        </button>
        <button
          type="button"
          onClick={() => setInputMode('dataset')}
          className={`py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
            inputMode === 'dataset'
              ? 'bg-[#2b2f36] text-[#e6e8ec]'
              : 'text-[#8b919c] hover:text-[#e6e8ec]'
          }`}
        >
          Dataset
        </button>
      </div>

      {inputMode === 'presets' && (
        <div className="space-y-3">
          <div className="text-xs text-[#8b919c] space-y-1">
            <p>
              Initial motion data derived from Eadweard Muybridge&apos;s 1887{' '}
              <span className="italic text-[#e6e8ec]">Animal Locomotion</span> chronophotography plates
              with segmental CoM tracking inspired by{' '}
              <a
                href="https://github.com/Abradshaw1/Muybridge"
                target="_blank"
                rel="noreferrer"
                className="text-[#34d399] underline underline-offset-2 hover:text-[#86efac]"
              >
                Abradshaw1/Muybridge
              </a>
              .
            </p>
            <p>
              Archive:{' '}
              <a
                href="https://bodiesinmotion.photo/muybridge"
                target="_blank"
                rel="noreferrer"
                className="text-[#c084fc] underline underline-offset-2 hover:text-[#e6e8ec]"
              >
                bodiesinmotion.photo/muybridge
              </a>
            </p>
          </div>
          <div className="space-y-2">
            {sampleClips.map((clip) => {
              const active = activeSourceId === clip.id;
              return (
                <button
                  key={clip.id}
                  type="button"
                  onClick={() => onSelectSampleClip(clip)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#a855f7]/12 border-[#a855f7]/60'
                      : 'bg-[#0e0f11] border-[#2b2f36] hover:border-[#3d434d]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-[#e6e8ec]">{clip.name}</span>
                    <span className="font-mono-tabular text-xs text-[#34d399] whitespace-nowrap">
                      {clip.frames.length}f · {clip.fps} fps
                    </span>
                  </div>
                  <p className="text-xs text-[#8b919c] mt-1">{clip.subtitle}</p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {inputMode === 'media' && (
        <div className="space-y-4">
          <div className="relative aspect-video bg-[#0e0f11] rounded-lg overflow-hidden border border-[#2b2f36]">
            {mediaPreviewUrl && mediaKind === 'video' ? (
              <>
                <video
                  ref={videoRef}
                  src={mediaPreviewUrl}
                  controls
                  className="w-full h-full object-contain"
                  crossOrigin="anonymous"
                  muted
                />
                <canvas
                  ref={overlayCanvasRef}
                  width={480}
                  height={270}
                  className="pointer-events-none absolute inset-0 w-full h-full"
                />
              </>
            ) : mediaPreviewUrl && mediaKind === 'photo' ? (
              <>
                <img
                  ref={photoImgRef}
                  src={mediaPreviewUrl}
                  alt="Uploaded figure reference"
                  className="w-full h-full object-contain"
                />
                <canvas
                  ref={overlayCanvasRef}
                  width={480}
                  height={270}
                  className="pointer-events-none absolute inset-0 w-full h-full"
                />
              </>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-full flex flex-col items-center justify-center gap-2 text-center p-4 hover:bg-[#191b1f]/60 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2 text-[#8b919c]">
                  <ImageIcon className="w-7 h-7" />
                  <Film className="w-7 h-7" />
                </div>
                <span className="text-sm font-medium text-[#e6e8ec]">
                  Choose a photo or video file
                </span>
                <span className="text-xs text-[#8b919c]">
                  Portraits, close-ups &amp; full figures · JPG, PNG, WebP, MP4, WebM
                </span>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onMediaSelect(file);
                e.target.value = '';
              }}
              className="hidden"
            />
          </div>

          {mediaKind !== 'none' && (
            <div className="flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 text-[#a855f7] hover:text-[#c084fc] transition-colors cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                Replace {mediaKind === 'photo' ? 'photo' : 'video'}
              </button>
              {(activeSourceId === 'photo' || activeSourceId === 'video') && (
                <span className="font-mono-tabular text-[#34d399]">
                  {FRAMING_LABELS[detectedFraming]}
                </span>
              )}
            </div>
          )}

          {mediaKind === 'video' && (
            <div className="space-y-3 pt-1 border-t border-[#2b2f36]">
              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-[#8b919c]">Sample Rate</span>
                  <span className="font-mono-tabular text-[#e6e8ec]">{sampleFps} fps</span>
                </div>
                <input
                  type="range"
                  min={2}
                  max={10}
                  step={1}
                  value={sampleFps}
                  onChange={(e) => onSampleFpsChange(Number(e.target.value))}
                  className="studio-range w-full"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-[#8b919c]">Frame Limit</span>
                  <span className="font-mono-tabular text-[#e6e8ec]">{maxFrames} frames</span>
                </div>
                <input
                  type="range"
                  min={8}
                  max={60}
                  step={4}
                  value={maxFrames}
                  onChange={(e) => onMaxFramesChange(Number(e.target.value))}
                  className="studio-range w-full"
                />
              </div>
            </div>
          )}

          {mediaKind === 'photo' && (
            <p className="text-xs text-[#8b919c]">
              Extracts visible facial &amp; body landmarks on the clearest figure and automatically zooms the stage to match close-ups, bust portraits, or full silhouettes.
            </p>
          )}

          <button
            type="button"
            onClick={mediaKind !== 'none' ? onAnalyzeMedia : () => fileInputRef.current?.click()}
            disabled={isProcessing}
            className="w-full py-2.5 px-4 rounded-lg bg-[#a855f7] hover:bg-[#9333ea] text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
          >
            <Play className="w-4 h-4" />
            {isProcessing
              ? 'Detecting Figure Parts...'
              : mediaKind === 'photo'
              ? 'Detect Pose & Zoom Stage'
              : mediaKind === 'video'
              ? 'Capture Motion from Video'
              : 'Select Photo or Video'}
          </button>

          {isProcessing && (
            <div className="p-3 rounded-lg bg-[#0e0f11] border border-[#2b2f36] space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#e6e8ec]">{processingProgress || 'Processing...'}</span>
                <span className="font-mono-tabular text-[#34d399]">
                  {Math.round(progressRatio * 100)}%
                </span>
              </div>
              <div className="w-full h-1.5 bg-[#2b2f36] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#10b981] transition-all duration-200"
                  style={{ width: `${Math.round(progressRatio * 100)}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-[#ff3b6b]/10 border border-[#ff3b6b]/40 text-xs text-[#ff8aa6]">
              {error}
            </div>
          )}
        </div>
      )}

      {inputMode === 'dataset' && (
        <div className="space-y-4">
          <p className="text-xs text-[#8b919c]">
            Load external pose datasets directly onto the cutout puppet without camera capture.
          </p>

          <button
            type="button"
            onClick={() => datasetInputRef.current?.click()}
            className="w-full py-6 px-4 rounded-lg bg-[#0e0f11] border border-dashed border-[#2b2f36] hover:border-[#a855f7]/60 flex flex-col items-center justify-center gap-2 text-center transition-colors cursor-pointer"
          >
            <Database className="w-7 h-7 text-[#34d399]" />
            <span className="text-sm font-medium text-[#e6e8ec]">Import Motion Dataset (.json)</span>
            <span className="text-xs text-[#8b919c]">
              COCO-17 arrays · OpenPose 17-joint tuples · Bitruvian .bsk.json
            </span>
          </button>
          <input
            ref={datasetInputRef}
            type="file"
            accept=".json,.bsk.json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleDatasetFile(file);
              e.target.value = '';
            }}
            className="hidden"
          />

          <div className="pt-2 border-t border-[#2b2f36] space-y-2">
            <button
              type="button"
              onClick={() => setShowPasteBox((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs text-[#c084fc] hover:text-[#e6e8ec] transition-colors cursor-pointer"
            >
              <FileJson className="w-3.5 h-3.5" />
              {showPasteBox ? 'Hide JSON Paste' : 'Or paste dataset JSON'}
            </button>

            {showPasteBox && (
              <div className="space-y-2">
                <textarea
                  value={pastedJson}
                  onChange={(e) => setPastedJson(e.target.value)}
                  rows={6}
                  placeholder='Paste COCO-17 JSON frames array or {"keyframes": [...]}'
                  className="w-full bg-[#0e0f11] border border-[#2b2f36] rounded-lg p-2.5 text-xs font-mono-tabular text-[#e6e8ec] placeholder:text-[#8b919c]/60 focus:outline-none focus:border-[#a855f7]"
                />
                <button
                  type="button"
                  disabled={!pastedJson.trim()}
                  onClick={() => onImportDatasetText(pastedJson, 'pasted-dataset.json')}
                  className="w-full py-2 px-4 rounded-lg bg-[#10b981] hover:bg-[#059669] text-[#0e0f11] text-xs font-semibold transition-colors disabled:opacity-40 cursor-pointer"
                >
                  Load Pasted Dataset
                </button>
              </div>
            )}
          </div>

          {datasetSummary && (
            <div className="p-3 rounded-lg bg-[#0e0f11] border border-[#10b981]/40 text-xs text-[#34d399]">
              {datasetSummary}
            </div>
          )}

          {datasetError && (
            <div className="p-3 rounded-lg bg-[#ff3b6b]/10 border border-[#ff3b6b]/40 text-xs text-[#ff8aa6]">
              {datasetError}
            </div>
          )}

          <div className="pt-2 border-t border-[#2b2f36] text-[11px] text-[#8b919c] space-y-1">
            <div className="font-medium text-[#e6e8ec]">Supported Schemas</div>
            <div>COCO-17 named keypoints or 51-value `[x, y, score]` frames</div>
            <div>Pixel-space coordinates auto-normalize to puppet stage</div>
            <div>Bitruvian `.bsk.json` keyframe animations</div>
          </div>
        </div>
      )}
    </div>
  );
};

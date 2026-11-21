import React from 'react';
import { Download, RotateCcw } from 'lucide-react';
import type { RigNode } from '../engine/types';

interface ExportPanelProps {
  selectedNode: RigNode | null;
  hasFrameOverride: boolean;
  overrideCount: number;
  totalFrames: number;
  onUpdateNodeAngle: (nodeId: string, angle: number) => void;
  onToggleFlipX: (nodeId: string) => void;
  onClearFrameOverride: () => void;
  onClearAllOverrides: () => void;
  onExportBsk: () => void;
  onExportCocoJson: () => void;
}

export const ExportPanel: React.FC<ExportPanelProps> = ({
  selectedNode,
  hasFrameOverride,
  overrideCount,
  totalFrames,
  onUpdateNodeAngle,
  onToggleFlipX,
  onClearFrameOverride,
  onClearAllOverrides,
  onExportBsk,
  onExportCocoJson,
}) => {
  return (
    <div className="space-y-5">
      {/* Selected Cardboard Piece / Joint Inspector */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-[#e6e8ec]">Selected Cardboard Joint</h3>
          {hasFrameOverride && (
            <button
              type="button"
              onClick={onClearFrameOverride}
              className="inline-flex items-center gap-1 text-xs text-[#a855f7] hover:text-[#c084fc] cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              Revert Frame
            </button>
          )}
        </div>

        {selectedNode ? (
          <div className="p-3.5 rounded-lg bg-[#0e0f11] border border-[#2b2f36] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-[#e6e8ec]">{selectedNode.name}</div>
                <div className="text-[11px] font-mono-tabular text-[#8b919c]">
                  {selectedNode.id} · limits [{selectedNode.limits[0]}°, {selectedNode.limits[1]}°]
                </div>
              </div>
              <span className="font-mono-tabular text-sm font-semibold text-[#34d399]">
                {selectedNode.ang.toFixed(1)}°
              </span>
            </div>

            <input
              type="range"
              min={selectedNode.limits[0]}
              max={selectedNode.limits[1]}
              step={0.5}
              value={selectedNode.ang}
              onChange={(e) => onUpdateNodeAngle(selectedNode.id, Number(e.target.value))}
              className="studio-range w-full"
            />

            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={() => onToggleFlipX(selectedNode.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                  selectedNode.flipX
                    ? 'bg-[#a855f7]/20 border-[#a855f7]/50 text-[#c084fc]'
                    : 'bg-[#191b1f] border-[#2b2f36] text-[#8b919c] hover:text-[#e6e8ec]'
                }`}
              >
                {selectedNode.flipX ? 'Mirrored X (Active)' : 'Mirror Cutout X'}
              </button>
              <button
                type="button"
                onClick={() => onUpdateNodeAngle(selectedNode.id, 0)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[#2b2f36] bg-[#191b1f] text-[#8b919c] hover:text-[#e6e8ec] transition-colors cursor-pointer"
              >
                Zero Angle
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-lg bg-[#0e0f11] border border-[#2b2f36] text-xs text-[#8b919c]">
            Click any cardboard cutout piece or green joint pin on the stage to pose and teach the loop while playing or paused.
          </div>
        )}

        {overrideCount > 0 && (
          <div className="flex items-center justify-between text-xs text-[#8b919c]">
            <span>{overrideCount} learned frame adaptation{overrideCount > 1 ? 's' : ''}</span>
            <button
              type="button"
              onClick={onClearAllOverrides}
              className="text-[#ff3b6b] hover:underline cursor-pointer"
            >
              Reset Learned Edits
            </button>
          </div>
        )}
      </div>

      {/* Export Section */}
      <div className="pt-4 border-t border-[#2b2f36] space-y-3">
        <h3 className="text-xs font-semibold text-[#e6e8ec]">Export Rig & Motion</h3>
        <p className="text-xs text-[#8b919c]">
          Export the solved cardboard cutout animation directly into Bitruvian Puppyt Studio format or raw COCO keypoints.
        </p>

        <button
          type="button"
          onClick={onExportBsk}
          disabled={totalFrames === 0}
          className="w-full py-2.5 px-4 rounded-lg bg-[#a855f7] hover:bg-[#9333ea] text-white text-xs font-semibold transition-colors disabled:opacity-40 flex items-center justify-center gap-2 cursor-pointer"
        >
          <Download className="w-4 h-4" />
          Download Bitruvian Puppet (.bsk.json)
        </button>

        <button
          type="button"
          onClick={onExportCocoJson}
          disabled={totalFrames === 0}
          className="w-full py-2.5 px-4 rounded-lg border border-[#2b2f36] bg-[#0e0f11] hover:border-[#3d434d] text-[#e6e8ec] text-xs font-medium transition-colors disabled:opacity-40 flex items-center justify-center gap-2 cursor-pointer"
        >
          <Download className="w-4 h-4" />
          Download COCO Keypoints (.json)
        </button>
      </div>
    </div>
  );
};

import React from 'react';
import type {
  BondStatusItem,
  CoMPoint,
  PinnedEffectors,
  RetargetOptions,
  RetargetSolverMode,
} from '../engine/types';

interface RetargetPanelProps {
  options: RetargetOptions;
  onOptionsChange: (next: RetargetOptions) => void;
  showJointPins: boolean;
  showCoM: boolean;
  showGuides: boolean;
  perspEnabled: boolean;
  showCocoOverlay: boolean;
  onToggleJointPins: () => void;
  onToggleCoM: () => void;
  onToggleGuides: () => void;
  onTogglePersp: () => void;
  onToggleCocoOverlay: () => void;
  bondStrain: BondStatusItem[];
  clampedNodes: string[];
  subjectConfidence: number;
  currentCom: CoMPoint | null;
  loopPass: number;
  learnedEditCount: number;
  onRunCleanupPass: () => void;
  onResetLoopLearner: () => void;
}

const SOLVER_MODES: Array<{ id: RetargetSolverMode; label: string; desc: string }> = [
  { id: 'fk-direct', label: 'Direct FK', desc: 'Bone-to-bone vector aiming' },
  { id: 'ik-analytical', label: 'Analytical IK', desc: '2-bone Law of Cosines limbs' },
  { id: 'ik-fabrik', label: 'FABRIK IK', desc: 'Iterative reach with soft damping' },
];

export const RetargetPanel: React.FC<RetargetPanelProps> = ({
  options,
  onOptionsChange,
  showJointPins,
  showCoM,
  showGuides,
  perspEnabled,
  showCocoOverlay,
  onToggleJointPins,
  onToggleCoM,
  onToggleGuides,
  onTogglePersp,
  onToggleCocoOverlay,
  bondStrain,
  clampedNodes,
  subjectConfidence,
  currentCom,
  loopPass,
  learnedEditCount,
  onRunCleanupPass,
  onResetLoopLearner,
}) => {
  const toggleRow = (
    label: string,
    checked: boolean,
    onChange: () => void,
    hint?: string,
  ) => (
    <label className="flex items-center justify-between gap-3 py-1.5 cursor-pointer">
      <div>
        <div className="text-xs font-medium text-[#e6e8ec]">{label}</div>
        {hint && <div className="text-[11px] text-[#8b919c]">{hint}</div>}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="w-4 h-4 accent-[#a855f7] rounded cursor-pointer shrink-0"
      />
    </label>
  );

  return (
    <div className="space-y-5">
      {/* Solver Selection */}
      <div>
        <h3 className="text-xs font-semibold text-[#e6e8ec] mb-2">Kinematic Solver</h3>
        <div className="grid grid-cols-3 gap-1 p-1 bg-[#0e0f11] rounded-lg border border-[#2b2f36]">
          {SOLVER_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onOptionsChange({ ...options, solverMode: m.id })}
              className={`py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                options.solverMode === m.id
                  ? 'bg-[#a855f7] text-white'
                  : 'text-[#8b919c] hover:text-[#e6e8ec]'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-[#8b919c] mt-1.5">
          {SOLVER_MODES.find((m) => m.id === options.solverMode)?.desc}
        </p>
      </div>

      {/* Temporal Smoothing, Shoulder Poise & Scale */}
      <div className="space-y-3 pt-3 border-t border-[#2b2f36]">
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-[#e6e8ec] font-medium">Shoulder Poise (Lotte Reiniger)</span>
            <span className="font-mono-tabular text-[#34d399]">
              {Math.round(options.shoulderPoise * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={options.shoulderPoise}
            onChange={(e) =>
              onOptionsChange({ ...options, shoulderPoise: Number(e.target.value) })
            }
            className="studio-range w-full"
          />
          <p className="text-[11px] text-[#8b919c] mt-1">
            Quiets collarbone shiver into composed cutout motion while keeping limbs expressive.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-[#8b919c]">Temporal Smoothing</span>
            <span className="font-mono-tabular text-[#e6e8ec]">
              {Math.round(options.smoothing * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={0.85}
            step={0.05}
            value={options.smoothing}
            onChange={(e) =>
              onOptionsChange({ ...options, smoothing: Number(e.target.value) })
            }
            className="studio-range w-full"
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-[#8b919c]">Subject Scale Calibration</span>
            <span className="font-mono-tabular text-[#e6e8ec]">
              {options.torsoScale.toFixed(2)}×
            </span>
          </div>
          <input
            type="range"
            min={0.75}
            max={1.25}
            step={0.05}
            value={options.torsoScale}
            onChange={(e) =>
              onOptionsChange({ ...options, torsoScale: Number(e.target.value) })
            }
            className="studio-range w-full"
          />
        </div>
      </div>

      {/* Rig & Cardboard Cutout Constraints */}
      <div className="pt-3 border-t border-[#2b2f36] divide-y divide-[#2b2f36]/60">
        {toggleRow(
          'Learn & Clean Up on Loops',
          options.loopLearning,
          () => onOptionsChange({ ...options, loopLearning: !options.loopLearning }),
          'Heals loop seams, removes shiver & absorbs live posing',
        )}
        {toggleRow(
          'Closed-Chain Shoulder Bond',
          options.bondOn,
          () => onOptionsChange({ ...options, bondOn: !options.bondOn }),
          'Couples navel swivel & clavicle tendon',
        )}
        {toggleRow(
          'Anatomical Joint Limits',
          options.constrainLimits,
          () => onOptionsChange({ ...options, constrainLimits: !options.constrainLimits }),
          'Prevents cardboard limb hyper-extension',
        )}
        {toggleRow(
          'Ground Contact Floor Lock',
          options.groundLock,
          () => onOptionsChange({ ...options, groundLock: !options.groundLock }),
          'Locks 2 real foot soles against stage floor',
        )}
        {toggleRow(
          'Advanced Foot & Hand Physics',
          options.advancedPhysics,
          () => onOptionsChange({ ...options, advancedPhysics: !options.advancedPhysics }),
          'Heel-ball-toe gait roll, anti-skate & wrist momentum',
        )}
        {toggleRow(
          'Hand Ground Collision & Brace',
          options.handGroundPhysics,
          () => onOptionsChange({ ...options, handGroundPhysics: !options.handGroundPhysics }),
          'Palms collide cleanly & brace flat against ground',
        )}
        {toggleRow(
          'Mirror Left / Right',
          options.mirrorHorizontal,
          () => onOptionsChange({ ...options, mirrorHorizontal: !options.mirrorHorizontal }),
          'Flip horizontal orientation for side-reversed clips',
        )}
        {toggleRow('Green Joint Pins', showJointPins, onToggleJointPins)}
        {toggleRow(
          'Segmental CoM Arc',
          showCoM,
          onToggleCoM,
          'de Leva mass-weighted trajectory (Abradshaw1/Muybridge)',
        )}
        {toggleRow('1-Point Perspective Floor', perspEnabled, onTogglePersp)}
        {toggleRow('Vitruvian 1H–7H Guides', showGuides, onToggleGuides)}
        {toggleRow('COCO Reference Inset', showCocoOverlay, onToggleCocoOverlay)}
      </div>

      {/* Ground Pinning & Tilt-Down Depth */}
      <div className="pt-3 border-t border-[#2b2f36] space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-[#e6e8ec]">Ground Pinning &amp; Depth Tilt</span>
          <span className="font-mono-tabular text-[#34d399]">
            Tilt {options.floorTiltDeg >= 0 ? '+' : ''}
            {options.floorTiltDeg.toFixed(1)}°
          </span>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-[#8b919c]">Ground Pinning Grip</span>
            <span className="font-mono-tabular text-[#e6e8ec]">
              {Math.round(options.groundPinStrength * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={options.groundPinStrength}
            onChange={(e) =>
              onOptionsChange({ ...options, groundPinStrength: Number(e.target.value) })
            }
            className="studio-range w-full"
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-[#8b919c]">Floor Tilt Down (Depth)</span>
            <span className="font-mono-tabular text-[#e6e8ec]">
              {options.floorTiltDeg >= 0 ? '+' : ''}
              {options.floorTiltDeg.toFixed(1)}°
            </span>
          </div>
          <input
            type="range"
            min={-15}
            max={15}
            step={0.5}
            value={options.floorTiltDeg}
            onChange={(e) =>
              onOptionsChange({ ...options, floorTiltDeg: Number(e.target.value) })
            }
            className="studio-range w-full"
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-[#8b919c]">Foreground Depth Drop</span>
            <span className="font-mono-tabular text-[#e6e8ec]">
              {Math.round(options.depthEmulation * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={options.depthEmulation}
            onChange={(e) =>
              onOptionsChange({ ...options, depthEmulation: Number(e.target.value) })
            }
            className="studio-range w-full"
          />
        </div>

        <div>
          <div className="text-xs text-[#8b919c] mb-1.5">Pin Effectors to Ground</div>
          <div className="grid grid-cols-4 gap-1.5">
            {(
              [
                ['footL', 'Foot L'],
                ['footR', 'Foot R'],
                ['handL', 'Hand L'],
                ['handR', 'Hand R'],
              ] as Array<[keyof PinnedEffectors, string]>
            ).map(([key, label]) => {
              const active = options.pinnedEffectors[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    onOptionsChange({
                      ...options,
                      pinnedEffectors: {
                        ...options.pinnedEffectors,
                        [key]: !active,
                      },
                    })
                  }
                  className={`py-1.5 px-2 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    active
                      ? key.startsWith('foot')
                        ? 'bg-[#10b981]/18 border-[#10b981]/60 text-[#34d399]'
                        : 'bg-[#38bdf8]/18 border-[#38bdf8]/60 text-[#7dd3fc]'
                      : 'bg-[#0e0f11] border-[#2b2f36] text-[#8b919c] hover:text-[#e6e8ec]'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Cyclic Loop Learning Actions */}
      <div className="pt-3 border-t border-[#2b2f36] space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-[#e6e8ec]">Loop Refinement</span>
          <span className="font-mono-tabular text-[#34d399]">
            Pass {loopPass} · {learnedEditCount} posed frames
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onRunCleanupPass}
            className="py-1.5 px-3 rounded-lg border border-[#2b2f36] bg-[#0e0f11] hover:border-[#34d399]/60 text-xs font-medium text-[#e6e8ec] transition-colors cursor-pointer whitespace-nowrap"
          >
            Clean Loop Pass
          </button>
          <button
            type="button"
            onClick={onResetLoopLearner}
            disabled={loopPass === 0 && learnedEditCount === 0}
            className="py-1.5 px-3 rounded-lg border border-[#2b2f36] bg-[#0e0f11] hover:border-[#ff3b6b]/60 text-xs font-medium text-[#8b919c] hover:text-[#e6e8ec] disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
          >
            Reset Loop
          </button>
        </div>
      </div>

      {/* Live Shoulder Bond & Joint Tension Readout */}
      <div className="pt-3 border-t border-[#2b2f36] space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-[#e6e8ec]">Shoulder Bond & Limits</span>
          <span className="font-mono-tabular text-[#8b919c]">
            Keypoints {Math.round(subjectConfidence * 100)}%
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {(['L', 'R'] as const).map((side) => {
            const item = bondStrain.find((b) => b.side === side);
            const strained = !!item?.strained;
            return (
              <div
                key={side}
                className="p-2.5 rounded-lg bg-[#0e0f11] border border-[#2b2f36]"
              >
                <div className="text-[11px] text-[#8b919c]">
                  {side === 'L' ? 'Left' : 'Right'} Clavicle Bond
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="font-mono-tabular text-xs text-[#e6e8ec]">
                    {item ? `${item.delta >= 0 ? '+' : ''}${item.delta.toFixed(1)}°` : '0.0°'}
                  </span>
                  <span
                    className={`text-[11px] font-medium ${
                      strained ? 'text-[#ff3b6b]' : 'text-[#10b981]'
                    }`}
                  >
                    {strained ? '▲ STRAINED' : '● NOMINAL'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {currentCom && (
          <div className="flex items-center justify-between text-[11px] text-[#8b919c] pt-1">
            <span>Segmental CoM</span>
            <span className="font-mono-tabular text-[#34d399]">
              x {Math.round(currentCom.x)} · y {Math.round(currentCom.y)} pyxl
            </span>
          </div>
        )}

        {clampedNodes.length > 0 && (
          <div className="text-[11px] text-[#8b919c]">
            At anatomical limit:{' '}
            <span className="font-mono-tabular text-[#ff3b6b]">
              {clampedNodes.join(', ')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

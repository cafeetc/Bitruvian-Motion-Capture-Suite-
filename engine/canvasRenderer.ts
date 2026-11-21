import { SKELETON_CONNECTIONS } from '../constants';
import type { Person } from '../types';
import {
  DEG,
  getPieceWorldMatrix,
  getTensionRatio,
  mkCanvas,
  parentOf,
  pos,
  solveRig,
} from './fkEngine';
import {
  footContactInfo,
  getGroundTiltHandlePos,
  groundYAt,
  handContactInfo,
  skelFocalX,
} from './ikEngine';
import type {
  CoMPoint,
  PerspHandle,
  PerspectiveState,
  PinnedEffectors,
  PoseSnapshot,
  RenderMode,
  RigNode,
  RigPiece,
} from './types';

const GREEN = '#22c55e';
const MAGENTA = '#ff3b6b';
const PURPLE_GUIDE = 'rgba(168, 85, 247, 0.72)';
const PURPLE_GUIDE_TEXT = 'rgba(192, 132, 252, 0.92)';

const SK: Array<[number, number]> = [
  [1006, 140],
  [1511, 140],
  [1259, 890],
];

export interface RenderContextState {
  cv: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  nodes: RigNode[];
  by: Record<string, RigNode>;
  pieces: RigPiece[];
  sel: RigNode | null;
  hov: RigNode | null;
  W: number;
  H: number;
  z: number;
  ox: number;
  oy: number;
  dpr: number;
  mode: RenderMode;
  showBones: boolean;
  showGuides: boolean;
  showJointPins: boolean;
  constrainLimits: boolean;
  bondOn: boolean;
  bgColor: string;
  trailPoses?: PoseSnapshot[];
  comTrail?: CoMPoint[];
  currentCom?: CoMPoint | null;
  showCoM?: boolean;
  persp?: PerspectiveState;
  hoverPersp?: PerspHandle;
  draggingPersp?: PerspHandle;
  cocoOverlay?: Person | null;
  showCocoOverlay?: boolean;
  mirrorHorizontal?: boolean;
  handGroundPhysics?: boolean;
  pinnedEffectors?: PinnedEffectors;
}

export function renderTintedCutoutOverlay(
  ctx: CanvasRenderingContext2D,
  silBuf: OffscreenCanvas | HTMLCanvasElement,
  outBuf: OffscreenCanvas | HTMLCanvasElement,
  w: number,
  h: number,
  dpr: number,
  color: string,
  fillAlpha: number,
  outlineAlpha: number,
  drawShape: (g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => void,
): void {
  if (silBuf.width !== w || silBuf.height !== h) {
    silBuf.width = w;
    silBuf.height = h;
  }
  if (outBuf.width !== w || outBuf.height !== h) {
    outBuf.width = w;
    outBuf.height = h;
  }
  const sctx = silBuf.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  const octx = outBuf.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!sctx || !octx) return;

  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, w, h);
  drawShape(sctx);

  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = color;
  sctx.fillRect(0, 0, w, h);
  sctx.globalCompositeOperation = 'source-over';

  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, w, h);
  const r = Math.max(1.5, 2.2 * dpr);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    octx.drawImage(silBuf, Math.cos(a) * r, Math.sin(a) * r);
  }
  octx.globalCompositeOperation = 'destination-out';
  octx.drawImage(silBuf, 0, 0);
  octx.globalCompositeOperation = 'source-over';

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = fillAlpha;
  ctx.drawImage(silBuf, 0, 0);
  ctx.globalAlpha = outlineAlpha;
  ctx.drawImage(outBuf, 0, 0);
  ctx.restore();
}

export class StageRenderer {
  private glowGreen: OffscreenCanvas | HTMLCanvasElement | null = null;
  private glowMagenta: OffscreenCanvas | HTMLCanvasElement | null = null;
  private lo: OffscreenCanvas | HTMLCanvasElement | null = null;
  private loc: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private ghostBuf: OffscreenCanvas | HTMLCanvasElement | null = null;
  private xraySilBuf: OffscreenCanvas | HTMLCanvasElement | null = null;
  private xrayOutBuf: OffscreenCanvas | HTMLCanvasElement | null = null;
  private tmpMat = new Float64Array(6);
  private SKP = [0, 0, 0, 0, 0, 0];

  private mkGlow(rgb: string) {
    const c = mkCanvas(64, 64);
    const g = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, `rgba(${rgb},.95)`);
    r.addColorStop(0.35, `rgba(${rgb},.3)`);
    r.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  private drawArt(
    c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    f: number,
    w: number,
    h: number,
    state: RenderContextState,
  ) {
    const k = state.z * f;
    const X0 = state.ox * f;
    const Y0 = state.oy * f;

    c.save();
    for (const p of state.pieces) {
      const bm = p.bm;
      if (!bm || !p.node) continue;
      const q = getPieceWorldMatrix(p, this.tmpMat);
      const m0 = k * q[0];
      const m1 = k * q[1];
      const m2 = k * q[2];
      const m3 = k * q[3];
      const m4 = k * q[4] + X0;
      const m5 = k * q[5] + Y0;
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      const X = m0 * cx + m2 * cy + m4;
      const Y = m1 * cx + m3 * cy + m5;
      const r = 0.5 * Math.hypot(p.w, p.h) * Math.hypot(m0, m1);
      if (X + r < 0 || Y + r < 0 || X - r > w || Y - r > h) continue;
      c.setTransform(m0, m1, m2, m3, m4, m5);
      c.drawImage(bm, p.x, p.y, p.w, p.h);
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.restore();
  }

  private computeSkull(state: RenderContextState): boolean {
    const hd = state.by.head;
    if (!hd || !hd.pieces.length) return false;
    const w = hd.w;
    for (let i = 0; i < 2; i++) {
      const x = SK[i][0];
      const y = SK[i][1];
      this.SKP[i * 2] = (w[0] * x + w[2] * y + w[4]) * state.z + state.ox;
      this.SKP[i * 2 + 1] = (w[1] * x + w[3] * y + w[5]) * state.z + state.oy;
    }
    const ct = state.by.chinTip;
    if (ct) {
      const q = pos(ct, state.by);
      this.SKP[4] = q[0] * state.z + state.ox;
      this.SKP[5] = q[1] * state.z + state.oy;
    } else {
      const x = SK[2][0];
      const y = SK[2][1];
      this.SKP[4] = (w[0] * x + w[2] * y + w[4]) * state.z + state.ox;
      this.SKP[5] = (w[1] * x + w[3] * y + w[5]) * state.z + state.oy;
    }
    return true;
  }

  private forEachSegment(
    state: RenderContextState,
    sk: boolean,
    fn: (x0: number, y0: number, x1: number, y1: number, passKind: number) => void,
  ) {
    const { nodes, by, z, ox, oy } = state;
    for (const n of nodes) {
      const par = parentOf(n, by);
      if (par) {
        const a = pos(par, by);
        const b = pos(n, by);
        fn(a[0] * z + ox, a[1] * z + oy, b[0] * z + ox, b[1] * z + oy, n.ghost ? 2 : 0);
      }
      if (n.at) {
        const a = pos(n, by);
        const w = n.w;
        const t = n.at;
        fn(
          a[0] * z + ox,
          a[1] * z + oy,
          (w[0] * t[0] + w[2] * t[1] + w[4]) * z + ox,
          (w[1] * t[0] + w[3] * t[1] + w[5]) * z + oy,
          0,
        );
      }
      if (n.bar && by[n.bar[0]] && by[n.bar[1]]) {
        const a = pos(by[n.bar[0]], by);
        const b = pos(by[n.bar[1]], by);
        fn(a[0] * z + ox, a[1] * z + oy, b[0] * z + ox, b[1] * z + oy, 0);
      }
      if (n.bond && n.bond.aim && by[n.bond.aim.to]) {
        const A = pos(by[n.bond.aim.to], by);
        const Q = pos(n.bond, by);
        const strained = Math.abs(n.eff - n.ang) > 0.05;
        fn(Q[0] * z + ox, Q[1] * z + oy, A[0] * z + ox, A[1] * z + oy, strained ? 1 : 0);
      }
    }
    if (sk) {
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        fn(this.SKP[i * 2], this.SKP[i * 2 + 1], this.SKP[j * 2], this.SKP[j * 2 + 1], 0);
      }
    }
  }

  private drawBonesLayer(state: RenderContextState, analog: boolean) {
    const { ctx, nodes, by, sel, z, ox, oy, dpr } = state;
    const sk = this.computeSkull(state);
    this.glowGreen = this.glowGreen || this.mkGlow('34,197,94');
    this.glowMagenta = this.glowMagenta || this.mkGlow('255,59,107');

    if (analog) {
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.34)';
      ctx.lineWidth = 0.9 * dpr;
      ctx.beginPath();
      this.forEachSegment(state, sk, (a, b, c, e, kind) => {
        if (kind !== 2) {
          ctx.moveTo(a, b);
          ctx.lineTo(c, e);
        }
      });
      ctx.stroke();
    } else {
      ctx.lineCap = 'round';
      for (let pass = 0; pass < 3; pass++) {
        const strokeColor = pass === 1 ? MAGENTA : GREEN;
        const glowColor = pass === 1 ? 'rgba(255, 59, 107, 0.45)' : 'rgba(34, 197, 94, 0.45)';
        for (const [wd, al, blurPx] of [
          [7.5, 0.11, 10],
          [4.2, 0.22, 6],
          [1.3, 0.68, 3],
        ]) {
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = wd * dpr;
          ctx.shadowBlur = blurPx * dpr;
          ctx.shadowColor = glowColor;
          ctx.globalAlpha = al * (pass === 2 ? 0.3 : 1);
          ctx.beginPath();
          this.forEachSegment(state, sk, (a, b, c, e, kind) => {
            if (kind === pass) {
              ctx.moveTo(a, b);
              ctx.lineTo(c, e);
            }
          });
          ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
      ctx.globalAlpha = 1;
      ctx.lineCap = 'butt';
    }

    const drawDot = (x: number, y: number, isTension: boolean, ghost: boolean, scale = 1) => {
      const r = (analog ? 9 : 15) * scale * dpr;
      const g = isTension ? this.glowMagenta! : this.glowGreen!;
      const m = ghost ? 0.3 : 1;
      ctx.globalAlpha = (analog ? 0.55 : 0.92) * m;
      ctx.drawImage(g, x - r, y - r, 2 * r, 2 * r);
      if (!analog) {
        const r2 = 4 * scale * dpr;
        ctx.drawImage(g, x - r2, y - r2, 2 * r2, 2 * r2);
      }
    };

    for (const n of nodes) {
      if (n.id === 'wingL' || n.id === 'wingR') continue;
      if (n.ghost && analog) continue;
      const q = pos(n, by);
      const tension = getTensionRatio(n);
      const strainedBond = n.bond && Math.abs(n.eff - n.ang) > 0.05;
      const isSwivel = n.id.startsWith('swivel');
      drawDot(
        q[0] * z + ox,
        q[1] * z + oy,
        n === sel || tension.atLimit || !!strainedBond,
        n.ghost || isSwivel,
        isSwivel ? 0.65 : 1,
      );
    }

    ctx.globalAlpha = 1;
  }

  private drawJointPins(state: RenderContextState) {
    if (!state.showJointPins) return;
    const { ctx, nodes, by, sel, hov, z, ox, oy, dpr } = state;
    const pinnedJoints = new Set([
      'pelvis',
      'lumbar',
      'thorax',
      'neck',
      'head',
      'acromionL',
      'acromionR',
      'humerusL',
      'humerusR',
      'forearmL',
      'forearmR',
      'handL',
      'handR',
      'femurL',
      'femurR',
      'shinL',
      'shinR',
      'footL',
      'footR',
    ]);

    ctx.save();
    for (const n of nodes) {
      if (!pinnedJoints.has(n.id)) continue;
      const q = pos(n, by);
      const sx = q[0] * z + ox;
      const sy = q[1] * z + oy;
      const isActive = n === sel || n === hov;
      const tension = getTensionRatio(n);
      const r = (isActive ? 5.2 : 3.8) * dpr;

      const grad = ctx.createRadialGradient(sx - r * 0.28, sy - r * 0.28, r * 0.1, sx, sy, r);
      if (tension.atLimit) {
        grad.addColorStop(0, '#fda4af');
        grad.addColorStop(0.65, '#ff3b6b');
        grad.addColorStop(1, '#881337');
      } else {
        grad.addColorStop(0, '#bbf7d0');
        grad.addColorStop(0.6, '#22c55e');
        grad.addColorStop(1, '#065f46');
      }

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = (isActive ? 1.5 : 0.9) * dpr;
      ctx.strokeStyle = isActive ? '#86efac' : 'rgba(14, 15, 17, 0.88)';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(1.1, r * 0.32), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(5, 46, 22, 0.72)';
      ctx.fill();
    }
    ctx.restore();
  }

  private drawStageGuides(state: RenderContextState) {
    if (!state.showGuides) return;
    const { ctx, ox, oy, W, H, z, dpr } = state;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = PURPLE_GUIDE;
    ctx.fillStyle = PURPLE_GUIDE_TEXT;
    ctx.lineWidth = dpr;
    ctx.setLineDash([6 * dpr, 6 * dpr]);
    ctx.strokeRect(ox, oy, W * z, H * z);
    if (W === 2500) {
      ctx.beginPath();
      ctx.moveTo(1257 * z + ox, oy);
      ctx.lineTo(1257 * z + ox, H * z + oy);
      for (let k = 1; k <= 7; k++) {
        ctx.moveTo(ox, k * 1240 * z + oy);
        ctx.lineTo(W * z + ox, k * 1240 * z + oy);
      }
      ctx.stroke();
      ctx.font = `${11 * dpr}px "JetBrains Mono", monospace`;
      for (let k = 1; k <= 7; k++) {
        ctx.fillText(`${k}H`, ox + 6 * dpr, k * 1240 * z + oy - 4 * dpr);
      }
      ctx.fillText('MX 1257', 1257 * z + ox + 6 * dpr, oy + 14 * dpr);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawPerspectiveSystem(state: RenderContextState) {
    const persp = state.persp;
    if (!persp || !persp.enabled) return;
    const { ctx, cv, by, nodes, z, ox, oy, dpr, hoverPersp, draggingPersp } = state;
    const root = nodes.find((n) => !n.parent) || nodes[0];
    const yMin = -oy / z - 300;
    const yMax = (cv.height - oy) / z + 600;
    const vx = persp.vpX;
    const vy = persp.horizonY;
    const gy = persp.groundY;
    const tiltDeg = persp.tiltDownDeg ?? 0;
    const slopeRad = tiltDeg * DEG;
    const fx = skelFocalX(by, root);
    const dHG = gy - vy;
    const safeHG = Math.abs(dHG) < 18 ? (dHG >= 0 ? 18 : -18) : dHG;
    const cell = persp.floorScale;
    const raysN = 7;
    const toScreen = (wx: number, wy: number): [number, number] => [wx * z + ox, wy * z + oy];

    const worldLeft = -ox / z;
    const worldRight = (cv.width - ox) / z;
    const gLeftY = groundYAt(worldLeft, gy, vx, tiltDeg);
    const gRightY = groundYAt(worldRight, gy, vx, tiltDeg);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Subtle foreground depth wash extending downward from the tilted ground line
    const [glx, gly] = toScreen(worldLeft, gLeftY);
    const [grx, gry] = toScreen(worldRight, gRightY);
    const midGroundSy = (gly + gry) * 0.5;
    if (midGroundSy < cv.height) {
      const floorGrad = ctx.createLinearGradient(0, Math.min(gly, gry), 0, cv.height);
      floorGrad.addColorStop(0, 'rgba(168, 85, 247, 0.055)');
      floorGrad.addColorStop(1, 'rgba(16, 185, 129, 0.015)');
      ctx.fillStyle = floorGrad;
      ctx.beginPath();
      ctx.moveTo(glx, gly);
      ctx.lineTo(grx, gry);
      ctx.lineTo(cv.width, cv.height);
      ctx.lineTo(0, cv.height);
      ctx.closePath();
      ctx.fill();
    }

    const halfSpan = raysN * cell;
    for (let i = -raysN; i <= raysN; i++) {
      const gx = fx + i * cell;
      const gyHere = groundYAt(gx, gy, vx, tiltDeg);
      const dx = gx - vx;
      const dy = gyHere - vy;
      const safeDy = Math.abs(dy) < 18 ? (dy >= 0 ? 18 : -18) : dy;
      const tEnd =
        dHG >= 0
          ? Math.max(2.0, (yMax - vy) / safeDy)
          : Math.max(2.0, (vy - yMin) / Math.abs(safeDy));
      const ex = vx + dx * Math.min(9, tEnd);
      const ey = vy + safeDy * Math.min(9, tEnd);
      const [sx0, sy0] = toScreen(vx, vy);
      const [sx1, sy1] = toScreen(ex, ey);
      const isCore = Math.abs(i) <= 1;
      ctx.beginPath();
      ctx.moveTo(sx0, sy0);
      ctx.lineTo(sx1, sy1);
      ctx.strokeStyle = isCore ? 'rgba(168, 85, 247, 0.28)' : 'rgba(168, 85, 247, 0.13)';
      ctx.lineWidth = (isCore ? 1.15 : 0.85) * dpr;
      ctx.stroke();
    }

    // Perspective depth rungs (k < 0 tilts forward/down below ground line to emulate depth)
    const kSteps = [-0.72, -0.58, -0.42, -0.28, -0.15, 0, 0.35, 0.85, 1.55, 2.55, 4.0, 6.2, 9.5, 15.0];
    const tanTilt = Math.tan(slopeRad);
    for (const k of kSteps) {
      if (Math.abs(k) < 0.01) continue;
      const yk = vy + safeHG / (1 + k * 0.55);
      const scale = (yk - vy) / safeHG;
      if (scale <= 0.02) continue;
      const xl = vx + (fx - halfSpan - vx) * scale;
      const xr = vx + (fx + halfSpan - vx) * scale;
      const yL = yk + (xl - vx) * tanTilt * scale;
      const yR = yk + (xr - vx) * tanTilt * scale;
      const [sxL, syL] = toScreen(xl, yL);
      const [sxR, syR] = toScreen(xr, yR);
      if (Math.max(syL, syR) < -40 || Math.min(syL, syR) > cv.height + 40) continue;
      ctx.beginPath();
      ctx.moveTo(sxL, syL);
      ctx.lineTo(sxR, syR);
      ctx.strokeStyle =
        k < 0
          ? 'rgba(52, 211, 153, 0.20)'
          : `rgba(168, 85, 247, ${(0.2 / (1 + k * 0.18)).toFixed(3)})`;
      ctx.lineWidth = (k < 0 ? 1.0 : 0.85) * dpr;
      ctx.stroke();
    }

    const drawPinDiamond = (sx: number, sy: number, color: string) => {
      const s = 4.6 * dpr;
      ctx.beginPath();
      ctx.moveTo(sx, sy - s);
      ctx.lineTo(sx + s, sy);
      ctx.lineTo(sx, sy + s);
      ctx.lineTo(sx - s, sy);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.2 * dpr;
      ctx.strokeStyle = '#0e0f11';
      ctx.stroke();
    };

    // Real 2-foot sole contact shadows & pin anchors
    for (const fid of ['footL', 'footR'] as const) {
      const f = by[fid];
      if (!f) continue;
      const sole = footContactInfo(f, by);
      const floorHere = groundYAt(sole.midX, gy, vx, tiltDeg);
      const gap = Math.abs(floorHere - sole.maxY);
      const isPinned = Boolean(state.pinnedEffectors?.[fid]);
      if (gap < 950 || isPinned) {
        const contactY = gap < 260 ? Math.max(floorHere, sole.maxY) : floorHere;
        const contactAlpha = isPinned ? 0.65 : Math.max(0.08, 0.48 * (1 - gap / 950));
        const [csx, csy] = toScreen(sole.midX, contactY);
        const rx = Math.max(22 * dpr, sole.soleSpan * 0.45 * z);
        const ry = Math.max(5.5 * dpr, rx * 0.24);
        ctx.beginPath();
        ctx.ellipse(csx, csy, rx, ry, slopeRad, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(16, 185, 129, ${(contactAlpha * 0.42).toFixed(3)})`;
        ctx.fill();
        if (gap < 65 || isPinned) {
          ctx.strokeStyle = `rgba(52, 211, 153, ${(contactAlpha * 0.85).toFixed(3)})`;
          ctx.lineWidth = 1.1 * dpr;
          ctx.stroke();
        }
        if (isPinned) {
          drawPinDiamond(csx, csy, '#34d399');
        }
      }
    }

    // Hand floor contact & pin indicators
    if (state.handGroundPhysics || state.pinnedEffectors?.handL || state.pinnedEffectors?.handR) {
      for (const hid of ['handL', 'handR'] as const) {
        const h = by[hid];
        if (!h) continue;
        const hInfo = handContactInfo(h, by);
        const floorHere = groundYAt(hInfo.midX, gy, vx, tiltDeg);
        const gap = Math.abs(floorHere - hInfo.maxY);
        const isPinned = Boolean(state.pinnedEffectors?.[hid]);
        if (gap < 950 || isPinned) {
          const contactY = gap < 220 ? Math.max(floorHere, hInfo.maxY) : floorHere;
          const contactAlpha = isPinned ? 0.65 : Math.max(0.06, 0.42 * (1 - gap / 950));
          const [csx, csy] = toScreen(hInfo.midX, contactY);
          ctx.beginPath();
          ctx.ellipse(csx, csy, 22 * dpr, 6 * dpr, slopeRad, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(56, 189, 248, ${(contactAlpha * 0.38).toFixed(3)})`;
          ctx.fill();
          if (isPinned) {
            drawPinDiamond(csx, csy, '#38bdf8');
          }
        }
      }
    }

    // Horizon line & Tilted Ground line
    const hyS = vy * z + oy;
    const hHot = hoverPersp === 'horizon' || draggingPersp === 'horizon';
    const gHot = hoverPersp === 'ground' || draggingPersp === 'ground';
    const tHot = hoverPersp === 'tilt' || draggingPersp === 'tilt';

    ctx.strokeStyle = hHot ? '#34d399' : 'rgba(168, 85, 247, 0.38)';
    ctx.lineWidth = (hHot ? 1.8 : 1.0) * dpr;
    ctx.setLineDash([5 * dpr, 5 * dpr]);
    ctx.beginPath();
    ctx.moveTo(0, hyS);
    ctx.lineTo(cv.width, hyS);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = gHot || tHot ? '#34d399' : 'rgba(168, 85, 247, 0.62)';
    ctx.lineWidth = (gHot || tHot ? 2.1 : 1.35) * dpr;
    ctx.beginPath();
    ctx.moveTo(glx, gly);
    ctx.lineTo(grx, gry);
    ctx.stroke();

    const [vpx, vpy] = toScreen(vx, vy);
    const vpHot = hoverPersp === 'vp' || draggingPersp === 'vp';
    ctx.beginPath();
    ctx.arc(vpx, vpy, (vpHot ? 8 : 5.5) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = vpHot ? 'rgba(34, 197, 94, 0.35)' : 'rgba(168, 85, 247, 0.25)';
    ctx.fill();
    ctx.strokeStyle = vpHot ? GREEN : 'rgba(192, 132, 252, 0.8)';
    ctx.lineWidth = 1.3 * dpr;
    ctx.stroke();

    // Ground Tilt-Down Depth Handle
    const [twx, twy] = getGroundTiltHandlePos(persp);
    const [tsx, tsy] = toScreen(twx, twy);
    ctx.beginPath();
    ctx.arc(tsx, tsy, (tHot ? 8 : 5.5) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = tHot ? 'rgba(52, 211, 153, 0.38)' : 'rgba(168, 85, 247, 0.25)';
    ctx.fill();
    ctx.strokeStyle = tHot ? '#34d399' : 'rgba(192, 132, 252, 0.85)';
    ctx.lineWidth = 1.3 * dpr;
    ctx.stroke();

    ctx.font = `${Math.round(10 * dpr)}px "JetBrains Mono", monospace`;
    ctx.fillStyle = hHot ? '#34d399' : 'rgba(192, 132, 252, 0.65)';
    ctx.fillText('HORIZON', 12 * dpr, Math.max(14 * dpr, hyS - 5 * dpr));
    ctx.fillStyle = gHot ? '#34d399' : 'rgba(192, 132, 252, 0.78)';
    ctx.fillText(
      `GROUND${Math.abs(tiltDeg) >= 0.5 ? ` · TILT ${tiltDeg >= 0 ? '+' : ''}${tiltDeg.toFixed(0)}°` : ''}`,
      12 * dpr,
      Math.min(cv.height - 6 * dpr, gly - 6 * dpr),
    );
    ctx.fillStyle = tHot ? '#34d399' : 'rgba(192, 132, 252, 0.72)';
    ctx.fillText('TILT', tsx + 10 * dpr, tsy + 3 * dpr);
    ctx.restore();
  }

  private drawMotionBlurTrail(state: RenderContextState) {
    const trail = state.trailPoses;
    if (!trail || trail.length === 0) return;
    const { ctx, cv, nodes, by, pieces, z, ox, oy, dpr } = state;
    const root = nodes.find((n) => !n.parent) || nodes[0];
    if (!root) return;

    if (!this.ghostBuf) {
      this.ghostBuf = mkCanvas(cv.width, cv.height);
    } else if (this.ghostBuf.width !== cv.width || this.ghostBuf.height !== cv.height) {
      this.ghostBuf.width = cv.width;
      this.ghostBuf.height = cv.height;
    }
    const gctx = this.ghostBuf.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!gctx) return;

    const savedAng = nodes.map((n) => n.ang);
    const savedTx = root.tx;
    const savedTy = root.ty;

    const currentSnapshot: PoseSnapshot = {
      pose: Object.fromEntries(nodes.map((n) => [n.id, n.ang])),
      root: [savedTx, savedTy],
    };

    // Build continuous fluid sub-frame slices across the last 5 frames -> current pose
    const keyframes = [...trail.slice(-5), currentSnapshot];
    const slices: Array<{ snap: PoseSnapshot; t: number }> = [];
    const subSteps = 3;
    for (let k = 0; k < keyframes.length - 1; k++) {
      const a = keyframes[k];
      const b = keyframes[k + 1];
      for (let s = 0; s < subSteps; s++) {
        const u = s / subSteps;
        const blendedPose: Record<string, number> = {};
        for (const n of nodes) {
          const av = a.pose[n.id] ?? 0;
          const bv = b.pose[n.id] ?? 0;
          blendedPose[n.id] = av + (bv - av) * u;
        }
        const totalIdx = (k * subSteps + s) / ((keyframes.length - 1) * subSteps);
        slices.push({
          snap: {
            pose: blendedPose,
            root: [
              a.root[0] + (b.root[0] - a.root[0]) * u,
              a.root[1] + (b.root[1] - a.root[1]) * u,
            ],
          },
          t: totalIdx,
        });
      }
    }

    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.clearRect(0, 0, cv.width, cv.height);

    for (const slice of slices) {
      for (const n of nodes) {
        if (n.id in slice.snap.pose) n.ang = slice.snap.pose[n.id];
      }
      root.tx = slice.snap.root[0] ?? 0;
      root.ty = slice.snap.root[1] ?? 0;
      solveRig(nodes, by, state.bondOn, 0);

      // Exponential taper creates a feathered aerodynamic wing blur behind moving limbs
      gctx.globalAlpha = 0.02 + Math.pow(slice.t, 1.75) * 0.14;
      for (const p of pieces) {
        const bm = p.bm;
        if (!bm || !p.node) continue;
        const q = getPieceWorldMatrix(p, this.tmpMat);
        gctx.setTransform(z * q[0], z * q[1], z * q[2], z * q[3], z * q[4] + ox, z * q[5] + oy);
        gctx.drawImage(bm, p.x, p.y, p.w, p.h);
      }
    }

    // Cool luminous mist tint so the wing blur stays cohesive and unobtrusive
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.globalAlpha = 1;
    gctx.globalCompositeOperation = 'source-atop';
    gctx.fillStyle = 'rgba(134, 239, 172, 0.24)';
    gctx.fillRect(0, 0, cv.width, cv.height);
    gctx.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 0.56;
    ctx.filter = `blur(${Math.max(1.2, 2.2 * dpr).toFixed(1)}px)`;
    ctx.drawImage(this.ghostBuf, 0, 0);
    ctx.filter = 'none';
    ctx.restore();

    nodes.forEach((n, i) => {
      n.ang = savedAng[i];
    });
    root.tx = savedTx;
    root.ty = savedTy;
    solveRig(nodes, by, state.bondOn, 0);
  }

  private drawCoMOverlay(state: RenderContextState) {
    if (!state.showCoM) return;
    const { ctx, z, ox, oy, dpr, comTrail, currentCom } = state;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (comTrail && comTrail.length >= 2) {
      ctx.beginPath();
      for (let i = 0; i < comTrail.length; i++) {
        const sx = comTrail[i].x * z + ox;
        const sy = comTrail[i].y * z + oy;
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.58)';
      ctx.lineWidth = 1.6 * dpr;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    if (currentCom) {
      const cx = currentCom.x * z + ox;
      const cy = currentCom.y * z + oy;
      const r = 6.5 * dpr;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(34, 197, 94, 0.22)';
      ctx.fill();
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 1.4 * dpr;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - r * 1.45, cy);
      ctx.lineTo(cx + r * 1.45, cy);
      ctx.moveTo(cx, cy - r * 1.45);
      ctx.lineTo(cx, cy + r * 1.45);
      ctx.strokeStyle = 'rgba(134, 239, 172, 0.9)';
      ctx.lineWidth = 1.0 * dpr;
      ctx.stroke();

      ctx.font = `500 ${Math.round(9.5 * dpr)}px "JetBrains Mono", monospace`;
      ctx.fillStyle = 'rgba(134, 239, 172, 0.92)';
      ctx.fillText('CoM', cx + r + 4 * dpr, cy + 3 * dpr);
    }

    ctx.restore();
  }

  private drawCocoInset(state: RenderContextState) {
    if (!state.showCocoOverlay || !state.cocoOverlay) return;
    const { ctx, cv, dpr, cocoOverlay, mirrorHorizontal } = state;
    const boxW = Math.min(200 * dpr, cv.width * 0.24);
    const boxH = boxW * 0.72;
    const pad = 14 * dpr;
    const x0 = cv.width - boxW - pad;
    const y0 = pad;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(14, 15, 17, 0.88)';
    ctx.strokeStyle = 'rgba(43, 47, 54, 0.95)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.roundRect(x0, y0, boxW, boxH, 8 * dpr);
    ctx.fill();
    ctx.stroke();

    ctx.font = `500 ${10 * dpr}px "JetBrains Mono", monospace`;
    ctx.fillStyle = '#8b919c';
    ctx.fillText('COCO SOURCE', x0 + 10 * dpr, y0 + 16 * dpr);

    const kp = cocoOverlay.keypoints;
    const mapPt = (p: { x: number; y: number } | null): [number, number] | null => {
      if (!p) return null;
      const nx = mirrorHorizontal ? 1 - p.x : p.x;
      return [x0 + 10 * dpr + nx * (boxW - 20 * dpr), y0 + 22 * dpr + p.y * (boxH - 30 * dpr)];
    };

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.6 * dpr;
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
    for (const p of Object.values(kp)) {
      const pt = mapPt(p);
      if (!pt) continue;
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], 2.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  public render(state: RenderContextState) {
    const { ctx, cv, mode, bgColor, dpr } = state;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, cv.width, cv.height);

    this.drawPerspectiveSystem(state);
    this.drawMotionBlurTrail(state);

    if (mode === 'A') {
      this.drawArt(ctx, 1, cv.width, cv.height, state);
      if (state.showBones) {
        this.drawBonesLayer(state, true);
      }
      this.drawJointPins(state);
    } else {
      const w = cv.width;
      const h = cv.height;
      this.lo = this.lo || mkCanvas(w, h);
      if (this.lo.width !== w || this.lo.height !== h) {
        this.lo.width = w;
        this.lo.height = h;
      }
      this.loc = this.loc || (this.lo.getContext('2d') as CanvasRenderingContext2D);
      this.loc.setTransform(1, 0, 0, 1, 0, 0);
      this.loc.clearRect(0, 0, w, h);
      this.drawArt(this.loc, 1, w, h, state);

      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.drawImage(this.lo, 0, 0);
      ctx.restore();

      if (state.hov) {
        this.xraySilBuf = this.xraySilBuf || mkCanvas(w, h);
        this.xrayOutBuf = this.xrayOutBuf || mkCanvas(w, h);
        renderTintedCutoutOverlay(
          ctx,
          this.xraySilBuf,
          this.xrayOutBuf,
          w,
          h,
          dpr,
          GREEN,
          0.24,
          0.92,
          (g) => {
            for (const p of state.hov!.pieces) {
              if (!p.bm || !p.node) continue;
              const q = getPieceWorldMatrix(p, this.tmpMat);
              g.setTransform(state.z * q[0], state.z * q[1], state.z * q[2], state.z * q[3], state.z * q[4] + state.ox, state.z * q[5] + state.oy);
              g.drawImage(p.bm, p.x, p.y, p.w, p.h);
            }
          },
        );
      }

      this.drawBonesLayer(state, false);
    }

    this.drawCoMOverlay(state);
    this.drawStageGuides(state);
    this.drawCocoInset(state);
  }
}

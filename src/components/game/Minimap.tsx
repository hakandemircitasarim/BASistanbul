// HUD minimap: 200 px circle bottom-left driven by its own 30 Hz rAF (no React state per frame) + the clock. Track D.
import { useEffect, useRef } from 'react';
import { useEngine, useGameStore, useStore } from '@/game/state/useGameStore';
import type { MinimapSnapshot } from '@/game/minimap/MinimapRenderer';
import { countRender } from './renderCount';

export const MINIMAP_SIZE = 200;
const MINIMAP_HZ = 30;
const RANGE_FOOT_M = 110;
const RANGE_CAR_M = 180;

/** Fallback when engine.minimap is null: a rotated grid around the player plus the player triangle. */
function drawPlaceholder(ctx: CanvasRenderingContext2D, snap: MinimapSnapshot, size: number, rotate: boolean): void {
  const half = size / 2;
  const range = snap.inVehicle ? RANGE_CAR_M : RANGE_FOOT_M;
  const scale = half / range;
  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, size, size);
  ctx.translate(half, half);
  const rot = rotate ? snap.camYaw - Math.PI : 0;
  ctx.rotate(rot);
  ctx.strokeStyle = 'rgba(0,229,255,0.25)';
  ctx.lineWidth = 1;
  const step = 116 * scale;
  const ox = -((snap.px % 116) * scale), oz = -((snap.pz % 116) * scale);
  const ext = size;
  for (let i = -4; i <= 4; i++) {
    ctx.beginPath(); ctx.moveTo(ox + i * step, -ext); ctx.lineTo(ox + i * step, ext); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-ext, oz + i * step); ctx.lineTo(ext, oz + i * step); ctx.stroke();
  }
  ctx.rotate(Math.PI - snap.pyaw);
  ctx.fillStyle = snap.inVehicle ? '#ff7a00' : '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(0, 3.5); ctx.lineTo(-5, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function Clock() {
  countRender('Clock');
  const clock = useGameStore((s) => s.clock);
  return (
    <div className="game-font rounded-md border border-white/10 bg-[rgba(5,3,8,.55)] px-3 py-1 text-xl tabular-nums text-white backdrop-blur-md drop-shadow-[0_0_8px_rgba(0,229,255,.5)]">
      {clock}
    </div>
  );
}

export default function Minimap() {
  countRender('Minimap');
  const engine = useEngine();
  const store = useStore();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = MINIMAP_SIZE * dpr;
    canvas.height = MINIMAP_SIZE * dpr;
    const interval = 1000 / MINIMAP_HZ;
    let raf = 0;
    let last = -interval;
    const frame = (t: number): void => {
      raf = window.requestAnimationFrame(frame);
      if (t - last < interval) return;
      last = t - ((t - last) % interval);
      if (engine.disposed) return;
      const snap = engine.getMinimapSnapshot();
      const rotate = store.getState().settings.minimapRotate;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const mm = engine.minimap;
      if (mm) mm.draw(ctx, snap, MINIMAP_SIZE, snap.inVehicle ? RANGE_CAR_M : RANGE_FOOT_M, rotate);
      else drawPlaceholder(ctx, snap, MINIMAP_SIZE, rotate);
    };
    raf = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(raf);
  }, [engine, store]);

  return (
    <div className="absolute bottom-5 left-5 flex items-end gap-3">
      <div
        className="overflow-hidden rounded-full border-2 border-white/25 bg-[#0d3b5c] shadow-[0_0_0_3px_rgba(5,3,8,.55),0_0_28px_rgba(0,229,255,.35)]"
        style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}
      >
        <canvas ref={ref} style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE, display: 'block' }} />
      </div>
      <Clock />
    </div>
  );
}

// HUD speedometer (km/sa), vehicle name and vehicle health bar; rendered only while in a vehicle. Track D.
import { useGameStore } from '@/game/state/useGameStore';
import { countRender } from './renderCount';

export default function Speedometer() {
  countRender('Speedometer');
  const inVehicle = useGameStore((s) => s.inVehicle);
  const speed = useGameStore((s) => s.speedKmh);
  const name = useGameStore((s) => s.vehicleName);
  const health = useGameStore((s) => s.vehicleHealth);
  if (!inVehicle) return null;
  const pct = Math.max(0, Math.min(100, health));
  return (
    <div className="absolute bottom-6 right-6 flex flex-col items-end rounded-lg border border-white/10 bg-[rgba(5,3,8,.55)] px-5 py-3 backdrop-blur-md">
      <div className="flex items-baseline gap-2">
        <span className="game-font text-6xl tabular-nums leading-none text-white drop-shadow-[0_0_14px_rgba(0,229,255,.6)]">{speed}</span>
        <span className="game-font text-base uppercase tracking-widest text-[#00e5ff]">km/sa</span>
      </div>
      <div className="mt-1 text-sm uppercase tracking-[0.25em] text-white/80">{name}</div>
      <div className="mt-2 h-1.5 w-40 overflow-hidden rounded-sm bg-black/50">
        <div
          className="h-full transition-[width] duration-200"
          style={{ width: pct + '%', background: pct > 30 ? 'linear-gradient(90deg,#ff7a00,#ffb15c)' : '#ff2d2d', boxShadow: '0 0 8px rgba(255,122,0,.7)' }}
        />
      </div>
    </div>
  );
}

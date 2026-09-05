// HUD status: health (red) + armor (grey) bars and the money readout with a green delta pop. Track D.
import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '@/game/state/useGameStore';
import { cn } from '@/lib/utils';
import { formatMoney } from './theme';
import { countRender } from './renderCount';

const DELTA_POP_MS = 1600;

function Bar({ value, className, glow }: { value: number; className: string; glow: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2.5 w-40 overflow-hidden rounded-sm border border-white/15 bg-black/50">
      <div className={cn('h-full transition-[width] duration-200', className)} style={{ width: pct + '%', boxShadow: glow }} />
    </div>
  );
}

export default function StatusBars() {
  countRender('StatusBars');
  const health = useGameStore((s) => s.health);
  const armor = useGameStore((s) => s.armor);
  const money = useGameStore((s) => s.money);
  const prevMoney = useRef(money);
  const [delta, setDelta] = useState(0);

  useEffect(() => {
    const d = money - prevMoney.current;
    prevMoney.current = money;
    if (d === 0) return;
    setDelta(d);
    const t = window.setTimeout(() => setDelta(0), DELTA_POP_MS);
    return () => window.clearTimeout(t);
  }, [money]);

  return (
    <div className="absolute left-5 top-5 flex flex-col gap-1.5">
      <Bar value={health} className="bg-gradient-to-r from-[#ff2d2d] to-[#ff5a5a]" glow="0 0 10px rgba(255,45,45,.7)" />
      <Bar value={armor} className="bg-gradient-to-r from-[#9aa3b2] to-[#d6dbe6]" glow="0 0 8px rgba(214,219,230,.5)" />
      <div className="relative mt-1 flex items-baseline gap-2">
        <span className="game-font text-2xl tabular-nums text-white drop-shadow-[0_0_8px_rgba(0,229,255,.45)]">{formatMoney(money)}</span>
        {delta !== 0 ? (
          <span
            key={money}
            className={cn(
              'game-font animate-in fade-in slide-in-from-bottom-2 text-lg tabular-nums duration-300',
              delta > 0 ? 'text-[#4dff88] drop-shadow-[0_0_8px_rgba(77,255,136,.8)]' : 'text-[#ff5a5a] drop-shadow-[0_0_8px_rgba(255,90,90,.8)]',
            )}
          >
            {delta > 0 ? '+' : '-'}{formatMoney(Math.abs(delta))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

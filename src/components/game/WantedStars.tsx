// HUD wanted level: five lucide stars top-right, filled by `wanted`, pulsing while `wantedFlash`. Track D.
import { Star } from 'lucide-react';
import { useGameStore } from '@/game/state/useGameStore';
import { cn } from '@/lib/utils';
import { countRender } from './renderCount';

const SLOTS = [0, 1, 2, 3, 4];

export default function WantedStars() {
  countRender('WantedStars');
  const wanted = useGameStore((s) => s.wanted);
  const flash = useGameStore((s) => s.wantedFlash);
  return (
    <div className={cn('absolute right-5 top-5 flex gap-1', flash && 'animate-pulse')} aria-label={`Aranma: ${wanted}/5`}>
      {SLOTS.map((i) => (
        <Star
          key={i}
          size={28}
          strokeWidth={1.75}
          className={i < wanted ? 'fill-[#ff7a00] text-[#ffb15c] drop-shadow-[0_0_8px_rgba(255,122,0,.9)]' : 'fill-black/30 text-white/30'}
        />
      ))}
    </div>
  );
}

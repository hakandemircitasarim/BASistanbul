// Wasted/busted screen: HARCANDIN / YAKALANDIN, subtitle, 3 s countdown and a Devam button -> engine.respawn(). Track D.
import { useEffect, useState } from 'react';
import { useEngine, useGameStore } from '@/game/state/useGameStore';
import { NeonButton } from './NeonUi';
import { countRender } from './renderCount';

const COUNTDOWN_S = 3;

export default function GameOverScreen() {
  countRender('GameOverScreen');
  const engine = useEngine();
  const phase = useGameStore((s) => s.phase);
  const busted = phase === 'busted';
  const [left, setLeft] = useState(COUNTDOWN_S);

  useEffect(() => {
    setLeft(COUNTDOWN_S);
    const started = performance.now();
    const id = window.setInterval(() => {
      const remain = Math.max(0, Math.ceil(COUNTDOWN_S - (performance.now() - started) / 1000));
      setLeft(remain);
      if (remain <= 0) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[radial-gradient(ellipse_at_center,rgba(5,3,8,.35),rgba(5,3,8,.85))] text-white">
      <div
        className={
          'game-font animate-in zoom-in-75 fade-in text-7xl uppercase tracking-[0.2em] duration-500 md:text-8xl ' +
          (busted ? 'text-[#3b6bff] drop-shadow-[0_0_30px_rgba(59,107,255,.8)]' : 'text-[#ff2d95] drop-shadow-[0_0_30px_rgba(255,45,149,.8)]')
        }
      >
        {busted ? 'YAKALANDIN' : 'HARCANDIN'}
      </div>
      <div className="text-lg tracking-wide text-white/85">{busted ? 'Polis merkezinden serbest bırakıldın. -$500' : 'Hastanede uyandın.'}</div>
      <div className="game-font mt-2 text-4xl tabular-nums text-white/70">{left > 0 ? left : ''}</div>
      <NeonButton primary onClick={() => engine.respawn()}>Devam</NeonButton>
    </div>
  );
}

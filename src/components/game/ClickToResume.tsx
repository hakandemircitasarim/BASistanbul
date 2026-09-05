// Full-screen click catcher shown while playing without pointer lock ('Devam etmek için tıkla' -> engine.resume()). Track D.
import { useEngine, useGameStore } from '@/game/state/useGameStore';
import { countRender } from './renderCount';

export default function ClickToResume() {
  countRender('ClickToResume');
  const engine = useEngine();
  const phase = useGameStore((s) => s.phase);
  const locked = useGameStore((s) => s.pointerLocked);
  if (phase !== 'playing' || locked) return null;
  return (
    <div className="pointer-events-auto absolute inset-0 flex cursor-pointer items-end justify-center pb-10" onClick={() => engine.resume()}>
      <div className="game-font animate-pulse rounded-full border border-[#00e5ff]/60 bg-[rgba(5,3,8,.6)] px-5 py-2 text-base uppercase tracking-[0.2em] text-[#00e5ff] shadow-[0_0_18px_rgba(0,229,255,.45)] backdrop-blur-md">
        Devam etmek için tıkla
      </div>
    </div>
  );
}

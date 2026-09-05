// HUD mission header: top-center title, objective line and optional countdown timer. Track D.
import { useGameStore } from '@/game/state/useGameStore';
import { formatTimer } from './theme';
import { countRender } from './renderCount';

export default function MissionText() {
  countRender('MissionText');
  const title = useGameStore((s) => s.missionTitle);
  const objective = useGameStore((s) => s.missionObjective);
  const timer = useGameStore((s) => s.missionTimer);
  if (!title) return null;
  const urgent = timer !== null && timer <= 15;
  return (
    <div className="absolute left-1/2 top-5 flex -translate-x-1/2 flex-col items-center rounded-lg border border-white/10 bg-[rgba(5,3,8,.55)] px-6 py-2 text-center backdrop-blur-md">
      <div className="game-font text-lg uppercase tracking-[0.25em] text-[#ff7a00] drop-shadow-[0_0_10px_rgba(255,122,0,.7)]">{title}</div>
      {objective ? <div className="mt-0.5 max-w-md text-sm text-white/90">{objective}</div> : null}
      {timer !== null ? (
        <div className={'game-font mt-1 text-2xl tabular-nums ' + (urgent ? 'animate-pulse text-[#ff2d95]' : 'text-[#00e5ff]')}>{formatTimer(timer)}</div>
      ) : null}
    </div>
  );
}

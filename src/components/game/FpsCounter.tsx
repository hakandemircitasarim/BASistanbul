// Small FPS readout under the wanted stars, shown only when settings.showFps. Track D.
import { useGameStore } from '@/game/state/useGameStore';
import { countRender } from './renderCount';

export default function FpsCounter() {
  countRender('FpsCounter');
  const show = useGameStore((s) => s.settings.showFps);
  const fps = useGameStore((s) => s.fps);
  if (!show) return null;
  return <div className="absolute right-5 top-14 font-mono text-xs tabular-nums text-[#00e5ff]/90">{fps} FPS</div>;
}

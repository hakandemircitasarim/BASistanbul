// Loading screen (title + 'Yükleniyor...' + neon progress shimmer) shown while store.loading. Track D.
import { useGameStore } from '@/game/state/useGameStore';
import { GameTitle } from './NeonUi';
import { countRender } from './renderCount';

export default function LoadingScreen() {
  countRender('LoadingScreen');
  const text = useGameStore((s) => s.loadingText);
  return (
    <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-8 bg-[#050308] text-white">
      <GameTitle />
      <div className="game-font text-xl uppercase tracking-[0.3em] text-white/80">{text || 'Yükleniyor...'}</div>
      <div className="h-1 w-64 overflow-hidden rounded-full bg-white/10">
        <div className="h-full w-1/3 animate-[loading-slide_1.2s_ease-in-out_infinite] bg-gradient-to-r from-[#ff7a00] via-[#ff2d95] to-[#00e5ff]" />
      </div>
      <style>{'@keyframes loading-slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}'}</style>
    </div>
  );
}

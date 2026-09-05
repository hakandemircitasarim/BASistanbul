// Main menu over the live cinematic city: title + 'V I' badge, Başla / Kontroller / Ayarlar. Track D.
import { useEngine } from '@/game/state/useGameStore';
import { GameTitle, MenuShell, NeonButton } from './NeonUi';
import { countRender } from './renderCount';

export default function MainMenu({ onControls, onSettings }: { onControls: () => void; onSettings: () => void }) {
  countRender('MainMenu');
  const engine = useEngine();
  return (
    <MenuShell>
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#ff7a00] via-[#ff2d95] to-[#00e5ff] opacity-80" />
      <GameTitle />
      <p className="text-sm uppercase tracking-[0.35em] text-white/70">Turuncu Sahil · Neon Geceler</p>
      <div className="mt-4 flex flex-col items-center gap-3">
        <NeonButton primary autoFocus onClick={() => engine.newGame()}>Başla</NeonButton>
        <NeonButton onClick={onControls}>Kontroller</NeonButton>
        <NeonButton onClick={onSettings}>Ayarlar</NeonButton>
      </div>
      <div className="absolute bottom-4 right-5 text-[11px] uppercase tracking-[0.3em] text-white/40">Build 1</div>
    </MenuShell>
  );
}

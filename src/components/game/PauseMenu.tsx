// Pause menu: Duraklatıldı with Devam Et / Kontroller / Ayarlar / Ana Menü over the frozen scene. Track D.
import { useEngine } from '@/game/state/useGameStore';
import { GameTitle, MenuShell, NeonButton, ScreenHeading } from './NeonUi';
import { countRender } from './renderCount';

export default function PauseMenu({ onControls, onSettings }: { onControls: () => void; onSettings: () => void }) {
  countRender('PauseMenu');
  const engine = useEngine();
  return (
    <MenuShell className="bg-[rgba(5,3,8,.55)] backdrop-blur-sm">
      <GameTitle compact />
      <ScreenHeading>Duraklatıldı</ScreenHeading>
      <div className="flex flex-col items-center gap-3">
        <NeonButton primary autoFocus onClick={() => engine.resume()}>Devam Et</NeonButton>
        <NeonButton onClick={onControls}>Kontroller</NeonButton>
        <NeonButton onClick={onSettings}>Ayarlar</NeonButton>
        <NeonButton onClick={() => engine.toMainMenu()}>Ana Menü</NeonButton>
      </div>
      <div className="text-xs uppercase tracking-[0.3em] text-white/50">Esc — Devam Et</div>
    </MenuShell>
  );
}

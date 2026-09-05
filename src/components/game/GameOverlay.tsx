// Root overlay: switches by phase (menu / playing / paused / wasted / busted) plus the local Kontroller/Ayarlar sub-screen. Track D.
import { useEffect, useState } from 'react';
import { useGameStore } from '@/game/state/useGameStore';
import Hud from './Hud';
import MainMenu from './MainMenu';
import PauseMenu from './PauseMenu';
import ControlsHelp from './ControlsHelp';
import SettingsMenu from './SettingsMenu';
import GameOverScreen from './GameOverScreen';
import ClickToResume from './ClickToResume';
import LoadingScreen from './LoadingScreen';
import DebugPanel from './DebugPanel';
import { countRender } from './renderCount';

type SubScreen = 'none' | 'controls' | 'settings';

export default function GameOverlay() {
  countRender('GameOverlay');
  const loading = useGameStore((s) => s.loading);
  const phase = useGameStore((s) => s.phase);
  const [sub, setSub] = useState<SubScreen>('none');

  // Any phase change (Esc resume, Başla, game over) closes the sub-screen.
  useEffect(() => { setSub('none'); }, [phase]);

  if (loading) return <LoadingScreen />;

  const back = (): void => setSub('none');
  const subScreen = sub === 'controls' ? <ControlsHelp onBack={back} /> : sub === 'settings' ? <SettingsMenu onBack={back} /> : null;

  if (phase === 'menu') {
    return (
      <>
        {subScreen ?? <MainMenu onControls={() => setSub('controls')} onSettings={() => setSub('settings')} />}
        <DebugPanel />
      </>
    );
  }

  const gameOver = phase === 'wasted' || phase === 'busted';
  return (
    <>
      <Hud dimmed={phase === 'paused' || gameOver} />
      <ClickToResume />
      {phase === 'paused' ? (subScreen ?? <PauseMenu onControls={() => setSub('controls')} onSettings={() => setSub('settings')} />) : null}
      {gameOver ? <GameOverScreen /> : null}
      <DebugPanel />
    </>
  );
}

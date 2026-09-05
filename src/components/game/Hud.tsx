// In-game HUD container (pointer-events-none): bars, stars, mission, prompt, toasts, speedometer, minimap, flash. Track D.
import StatusBars from './StatusBars';
import WantedStars from './WantedStars';
import Speedometer from './Speedometer';
import Prompt from './Prompt';
import MissionText from './MissionText';
import Notifications from './Notifications';
import Minimap from './Minimap';
import HitFlash from './HitFlash';
import FpsCounter from './FpsCounter';
import { countRender } from './renderCount';

export default function Hud({ dimmed }: { dimmed?: boolean }) {
  countRender('Hud');
  return (
    <div className={'pointer-events-none absolute inset-0 select-none text-white transition-opacity duration-300' + (dimmed ? ' opacity-40' : '')}>
      <HitFlash />
      <StatusBars />
      <Notifications />
      <WantedStars />
      <FpsCounter />
      <MissionText />
      <Speedometer />
      <Prompt />
      <Minimap />
    </div>
  );
}

// Game page: full-screen canvas with the overlay UI. Track P0.
import GameCanvas from '@/components/game/GameCanvas';
import GameOverlay from '@/components/game/GameOverlay';

const Index = () => (
  <GameCanvas>
    <GameOverlay />
  </GameCanvas>
);

export default Index;

// HUD interaction prompt: bottom-center pill with a key chip ("E - Araca bin" -> [E] Araca bin). Track D.
import { useGameStore } from '@/game/state/useGameStore';
import { countRender } from './renderCount';

export default function Prompt() {
  countRender('Prompt');
  const prompt = useGameStore((s) => s.prompt);
  if (!prompt) return null;
  const sep = prompt.indexOf(' - ');
  const key = sep > 0 ? prompt.slice(0, sep) : null;
  const text = sep > 0 ? prompt.slice(sep + 3) : prompt;
  return (
    <div className="absolute bottom-24 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-[rgba(5,3,8,.6)] py-2 pl-2 pr-5 backdrop-blur-md">
      {key ? (
        <span className="game-font inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-[#ff7a00] bg-[#ff7a00]/20 px-2 text-base text-[#ffb15c] shadow-[0_0_10px_rgba(255,122,0,.6)]">
          {key}
        </span>
      ) : null}
      <span className="text-base font-semibold tracking-wide text-white">{text}</span>
    </div>
  );
}

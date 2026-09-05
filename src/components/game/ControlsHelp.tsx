// Controls table (Turkish key bindings) with a Geri button. Track D.
import { MenuShell, NeonButton, Panel, ScreenHeading } from './NeonUi';
import { countRender } from './renderCount';

const ROWS: [string, string][] = [
  ['W A S D', 'Hareket'],
  ['Shift', 'Koş'],
  ['Boşluk', 'Zıpla / El freni'],
  ['E', 'Araca bin / in'],
  ['H', 'Korna'],
  ['Q / R', 'Kamera (fare kilidi yokken)'],
  ['L', 'Farlar'],
  ['M', 'Sessiz'],
  ['V', 'Kamera mesafesi'],
  ['Esc', 'Duraklat'],
  ['F3', 'Hata ayıklama'],
];

export default function ControlsHelp({ onBack }: { onBack: () => void }) {
  countRender('ControlsHelp');
  return (
    <MenuShell className="bg-[rgba(5,3,8,.55)] backdrop-blur-sm">
      <Panel className="w-full max-w-md px-6 py-5">
        <ScreenHeading>Kontroller</ScreenHeading>
        <table className="w-full border-separate border-spacing-y-1 text-sm">
          <tbody>
            {ROWS.map(([key, desc]) => (
              <tr key={key}>
                <td className="w-32 pr-3 text-right align-middle">
                  <span className="game-font inline-block rounded-md border border-[#ff7a00]/80 bg-[#ff7a00]/15 px-2 py-0.5 text-sm text-[#ffb15c] shadow-[0_0_8px_rgba(255,122,0,.4)]">{key}</span>
                </td>
                <td className="pl-2 align-middle text-white/60">—</td>
                <td className="pl-2 align-middle tracking-wide text-white">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <NeonButton autoFocus onClick={onBack}>Geri</NeonButton>
    </MenuShell>
  );
}

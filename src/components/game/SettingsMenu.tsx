// Settings screen (shadcn Switch/Slider/Select) writing through engine.applySettings; persisted by the store. Track D.
import type { ReactNode } from 'react';
import { useEngine, useGameStore } from '@/game/state/useGameStore';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MenuShell, NeonButton, Panel, ScreenHeading } from './NeonUi';
import { countRender } from './renderCount';

const SWITCH_CLASS = 'data-[state=checked]:bg-[#ff7a00] data-[state=unchecked]:bg-white/20 [&>span]:bg-white focus-visible:ring-[#00e5ff] focus-visible:ring-offset-0';
const SLIDER_CLASS = 'w-40 [&>span:first-child]:bg-white/15 [&>span:first-child>span]:bg-[#ff7a00] [&_[role=slider]]:border-[#ff7a00] [&_[role=slider]]:bg-white [&_[role=slider]]:shadow-[0_0_8px_rgba(255,122,0,.7)]';

function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="flex flex-col">
        <span className="text-sm font-semibold tracking-wide text-white">{label}</span>
        {hint ? <span className="text-xs tabular-nums text-white/50">{hint}</span> : null}
      </div>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

export default function SettingsMenu({ onBack }: { onBack: () => void }) {
  countRender('SettingsMenu');
  const engine = useEngine();
  const s = useGameStore((st) => st.settings);
  return (
    <MenuShell className="bg-[rgba(5,3,8,.55)] backdrop-blur-sm">
      <Panel className="w-full max-w-md divide-y divide-white/10 px-6 py-5">
        <ScreenHeading>Ayarlar</ScreenHeading>
        <Row label="Grafik kalitesi">
          <Select value={s.quality} onValueChange={(v) => engine.applySettings({ quality: v === 'low' ? 'low' : 'high' })}>
            <SelectTrigger className="h-9 w-36 border-white/20 bg-white/10 text-white focus:ring-[#00e5ff] focus:ring-offset-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-white/15 bg-[#140a1c] text-white">
              <SelectItem value="low" className="focus:bg-[#ff7a00]/30 focus:text-white">Düşük</SelectItem>
              <SelectItem value="high" className="focus:bg-[#ff7a00]/30 focus:text-white">Yüksek</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label="Gölgeler">
          <Switch className={SWITCH_CLASS} checked={s.shadows} onCheckedChange={(v) => engine.applySettings({ shadows: v })} />
        </Row>
        <Row label="Ortam örtüşmesi (AO)">
          <Switch className={SWITCH_CLASS} checked={s.ao} onCheckedChange={(v) => engine.applySettings({ ao: v })} />
        </Row>
        <Row label="Fare hassasiyeti" hint={s.mouseSensitivity.toFixed(2)}>
          <Slider className={SLIDER_CLASS} min={0.5} max={3} step={0.05} value={[s.mouseSensitivity]} onValueChange={(v) => engine.applySettings({ mouseSensitivity: v[0] })} />
        </Row>
        <Row label="Y eksenini ters çevir">
          <Switch className={SWITCH_CLASS} checked={s.invertY} onCheckedChange={(v) => engine.applySettings({ invertY: v })} />
        </Row>
        <Row label="Ses seviyesi" hint={Math.round(s.volume * 100) + '%'}>
          <Slider className={SLIDER_CLASS} min={0} max={1} step={0.01} value={[s.volume]} onValueChange={(v) => engine.applySettings({ volume: v[0] })} />
        </Row>
        <Row label="Sessiz">
          <Switch className={SWITCH_CLASS} checked={s.muted} onCheckedChange={(v) => engine.applySettings({ muted: v })} />
        </Row>
        <Row label="Mini harita dönsün">
          <Switch className={SWITCH_CLASS} checked={s.minimapRotate} onCheckedChange={(v) => engine.applySettings({ minimapRotate: v })} />
        </Row>
        <Row label="FPS göster">
          <Switch className={SWITCH_CLASS} checked={s.showFps} onCheckedChange={(v) => engine.applySettings({ showFps: v })} />
        </Row>
      </Panel>
      <NeonButton autoFocus onClick={onBack}>Geri</NeonButton>
    </MenuShell>
  );
}

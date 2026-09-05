// HudPublisher tests: cadence (<= 10 Hz), changed-fields-only patches, event-driven publishNow, formatting. Track D.
import { test, expect, createHeadless } from './harness';
import { HudPublisher, formatClock, formatMoney } from '../../src/game/state/HudPublisher';

test('hud: formatClock / formatMoney', () => {
  expect(formatClock(18) === '18:00', 'formatClock 18 -> 18:00, got ' + formatClock(18));
  expect(formatClock(7.5) === '07:30', 'formatClock 7.5 -> 07:30, got ' + formatClock(7.5));
  expect(formatClock(23.999) === '23:59', 'formatClock 23.999 -> 23:59, got ' + formatClock(23.999));
  expect(formatMoney(1250) === '$1.250', 'formatMoney 1250 -> $1.250, got ' + formatMoney(1250));
  expect(formatMoney(1000000) === '$1.000.000', 'formatMoney 1e6, got ' + formatMoney(1000000));
  expect(formatMoney(500) === '$500', 'formatMoney 500, got ' + formatMoney(500));
  expect(formatMoney(-500) === '-$500', 'formatMoney -500, got ' + formatMoney(-500));
});

test('hud: initial publish mirrors the world and later publishes only when something changed', () => {
  const h = createHeadless({ systems: () => [new HudPublisher()], hour: 18.25 });
  const store = h.ctx.store;
  let notifies = 0;
  store.subscribe(() => { notifies++; });
  const s0 = store.getState();
  expect(s0.clock === '18:15', 'clock published on init, got ' + s0.clock);
  expect(s0.money === 1000 && s0.health === 100, 'money/health mirrored');
  expect(s0.phase === 'playing', 'phase mirrored');
  // Nothing changes in the world -> the store must not notify at all over 120 ticks.
  h.step(120);
  expect(notifies === 0, 'no store notifications while nothing changed, got ' + notifies);
  // A change is picked up within 6 ticks.
  h.world.player.money = 1500;
  h.step(6);
  expect(store.getState().money === 1500, 'money updated after <= 6 ticks');
  expect(notifies === 1, 'exactly one notification for one change, got ' + notifies);
});

test('hud: publish cadence stays at or below 10 Hz under continuous change', () => {
  const h = createHeadless({ systems: () => [new HudPublisher()] });
  const store = h.ctx.store;
  let notifies = 0;
  store.subscribe(() => { notifies++; });
  for (let i = 0; i < 600; i++) { // 10 simulated seconds, health changes every tick
    h.world.player.health = 100 - (i % 50);
    h.step(1);
  }
  expect(notifies <= 100, 'at most 100 publishes in 10 s (10 Hz), got ' + notifies);
  expect(notifies >= 90, 'publishes actually happen every 6 ticks, got ' + notifies);
});

test('hud: events trigger publishNow and notifications land in the store', () => {
  const h = createHeadless({ systems: () => [new HudPublisher()] });
  const store = h.ctx.store;
  h.world.wanted.stars = 2;
  h.ctx.events.emit('wanted:changed', { stars: 2, prev: 0 });
  expect(store.getState().wanted === 2, 'wanted:changed publishes immediately (no tick needed)');
  h.ctx.events.emit('notify', { text: 'Aranıyorsun!', kind: 'police' });
  const n = store.getState().notifications;
  expect(n.length === 1 && n[0].text === 'Aranıyorsun!' && n[0].kind === 'police', 'notify event appended to store.notifications');
  h.ctx.events.emit('mission:completed', { id: 'sahil', reward: 500 });
  expect(store.getState().lastReward === 500, 'mission:completed sets lastReward');
  h.world.hud.prompt = 'E - Araca bin';
  h.ctx.events.emit('player:damaged', { amount: 5, source: 'fall' });
  expect(store.getState().prompt === 'E - Araca bin', 'player:damaged publishes the current prompt');
});

test('hud: vehicle fields and mission timer', () => {
  const h = createHeadless({ systems: () => [new HudPublisher()] });
  const store = h.ctx.store;
  const m = h.world.mission;
  m.activeId = 'kurye'; m.activeTitle = 'Turuncu Kurye'; m.objective = 'Aracı garaja götür'; m.timeLimit = 90; m.elapsed = 12.4;
  h.step(6);
  const s = store.getState();
  expect(s.missionTitle === 'Turuncu Kurye' && s.missionObjective === 'Aracı garaja götür', 'mission text mirrored');
  expect(s.missionTimer === 78, 'missionTimer = ceil(90 - 12.4) = 78, got ' + s.missionTimer);
  expect(s.inVehicle === false && s.speedKmh === 0 && s.vehicleName === '', 'on foot: no vehicle fields');
  m.activeId = null;
  h.step(6);
  expect(store.getState().missionTitle === null && store.getState().missionTimer === null, 'mission cleared');
});

test('hud: debug stats only while showDebug', () => {
  let calls = 0;
  const stats = { fps: 60, drawCalls: 42, triangles: 1000, tickMs: 1.5, vehicles: 3, peds: 0, police: 0, traffic: 0 };
  const h = createHeadless({ systems: () => [new HudPublisher({ debugStats: () => { calls++; return stats; }, fps: () => 59.6 })] });
  const store = h.ctx.store;
  h.step(12);
  expect(calls === 0 && store.getState().debug === null, 'no debug sampling while hidden');
  expect(store.getState().fps === 60, 'fps published from the hook (rounded), got ' + store.getState().fps);
  store.setState({ showDebug: true });
  h.step(6);
  const d = store.getState().debug;
  expect(calls > 0 && d !== null && d.drawCalls === 42, 'debug sampled when shown');
  expect(d !== stats, 'store never aliases the pooled stats object');
  const before = calls;
  h.step(6);
  expect(calls === before + 1 && store.getState().debug === d, 'unchanged stats keep the same store reference');
  store.setState({ showDebug: false });
  h.step(6);
  expect(store.getState().debug === null, 'debug cleared when hidden');
});

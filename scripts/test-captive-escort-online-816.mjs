// Player report #816 — "There was no option to move the captured rebel leader
// when the empire player moves the fleet."
//
// An ONLINE-only gap, the same shape as #735. Hotseat has offered the captive
// escort since #595 (activate) and #731 (Catch Them By Surprise), threading the
// choice into the engine's last argument. Online, `makeOnlinePhases` shadowed
// both calls with wrappers that took only the move orders, the action shape had
// no field for the captives, and the adapter called the engine without them —
// so the player's choice was dropped and the captive never moved.
//
// This file pins the whole chain: wrapper -> action -> adapter -> engine.
// Run: node scripts/test-captive-escort-online-816.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const { makeOnlinePhases } = await import('../src/online/onlineEngine.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// Reporter's shape: a carrier + trooper leave the prison, one trooper stays
// behind, so the captive is NOT auto-rescued and simply stays unless escorted.
const PRISON = 'corellia';
const build = () => {
  const G = createGame(data, { seed: 3, autoSetupUnits: true });
  const DEST = (G.catalog.adjacency[PRISON] ?? [])[0];
  G.phase = 'Command';
  G.currentPlayer = 'Empire';
  G.passedThisCommand = [];
  G.map.systems[PRISON].units = [];
  M.deployUnit(G, 'Empire', 'stormtrooper', PRISON);
  M.deployUnit(G, 'Empire', 'assault-carrier', PRISON);
  M.deployUnit(G, 'Empire', 'stormtrooper', PRISON);
  G.empire.capturedLeaders = [{ leaderId: 'mon-mothma', ring: 'captured', systemId: PRISON }];
  G.rebel.leaderPool = G.rebel.leaderPool.filter((l) => l !== 'mon-mothma');
  const moving = G.map.systems[PRISON].units.slice(0, 2).map((u) => u.instanceId);
  return { G, DEST, moving, leader: G.empire.leaderPool[0] };
};
const captiveAt = (G) => (G.empire.capturedLeaders ?? []).find((c) => c.leaderId === 'mon-mothma')?.systemId;

console.log('[ #816 the online wrappers carry the escort choice into the action ]');
{
  const sent = [];
  const online = makeOnlinePhases(async (a) => { sent.push(a); }, () => true);
  online.activateSystem(null, 'Empire', 'x', 'y', [], ['mon-mothma']);
  await new Promise((r) => setTimeout(r, 0));
  online.resolveCatchThemBySurpriseMovePick(null, [], ['mon-mothma']);
  await new Promise((r) => setTimeout(r, 0));
  check('activateSystem submits the captives',
    sent[0]?.kind === 'activateSystem' && sent[0]?.bringCapturedLeaderIds?.[0] === 'mon-mothma', JSON.stringify(sent[0]));
  check('Catch Them By Surprise submits the captives',
    sent[1]?.kind === 'resolveCatchThemBySurpriseMovePick' && sent[1]?.bringCapturedLeaderIds?.[0] === 'mon-mothma', JSON.stringify(sent[1]));
}

console.log('\n[ #816 the adapter honours it — the captive travels ]');
{
  const { G: G0, DEST, moving, leader } = build();
  const G = rebellionAdapter.applyAction(G0, { kind: 'activateSystem', leaderId: leader, targetSystemId: DEST,
    moveOrders: [{ fromSystemId: PRISON, unitInstanceIds: moving }], bringCapturedLeaderIds: ['mon-mothma'] }, 'Empire');
  check('captive relocated to the destination', captiveAt(G) === DEST, String(captiveAt(G)));
}

console.log('\n[ an action without the field still leaves the captive put ]');
{
  const { G: G0, DEST, moving, leader } = build();
  const G = rebellionAdapter.applyAction(G0, { kind: 'activateSystem', leaderId: leader, targetSystemId: DEST,
    moveOrders: [{ fromSystemId: PRISON, unitInstanceIds: moving }] }, 'Empire');
  check('units moved', G.map.systems[DEST].units.length >= 2);
  check('captive stays in the still-garrisoned prison', captiveAt(G) === PRISON, String(captiveAt(G)));
}

console.log('[ the choice is visible in the move panel (#816: "If there was an option, I couldn\'t find it") ]');
{
  // The offer used to be a pop-up after Activate. It is now a checkbox under
  // each source system holding a captive, and Activate passes the ticks on.
  const src = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
  check('the move panel shows a "Bring captured … along" checkbox per captive',
    /Bring captured <b>\{lname\}<\/b> along/.test(src) && /\(G\.empire\.capturedLeaders \?\? \[\]\)\.filter\(\(c\) => c\.systemId === sysId\)/.test(src));
  check('Activate passes the ticked captives through', /onActivate\(leaderId, targetSystemId, orders, bringCaptives\)/.test(src));
  check('…and the old pop-up is gone from the activation path', !/Bring the captured \$\{name\} along to \$\{dest\}\?[^`]*`\)\) \{\n\s*bringCaptives\.push\(cap\.leaderId\);\n\s*\}\n\s*\}\n\s*\}\n\s*const r = phases\.activateSystem/.test(src));
}

console.log(`\n${fail ? 'FAIL' : 'ALL PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Audit #15 (B-2/B-3): RoE Cinematic Combat — the once-per-attack reroll and
// the "Removing damage" ★-spend are now INTERACTIVE pause points (default
// pre-selected, player may override; AI takes the default). Base combat is
// unaffected (no such pauses).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
const opts = (seed, cinematic) => ({ seed, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo','corellia','kashyyyk'], forcedImperialLoyalty: ['alderaan','malastare','mygeeto','rodia','utapau'], expansion: { enabled: true, cinematicCombat: cinematic } });
let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };

// Pick an Empire leader with a positive space tactic value (for the reroll
// allowance) and set up a cinematic space attack at felucia.
function setupSpaceAttack(seed, cinematic) {
  const G = createGame(data, opts(seed, cinematic));
  for (let i = 0; i < 2; i++) M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  const ldr = Object.values(G.catalog.leaders).find((l) => l.side === 'Empire' && (l.tacticValues?.space ?? 0) > 0);
  G.empire.leadersOnBoard['felucia'] = [ldr.id];
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.activeTheater = 'space'; c.theaterStaged = []; c.theaterAttackersDone = [];
  return { G, c, allowance: ldr.tacticValues.space };
}

console.log('[ #15B: cinematic beginAttack pauses for the reroll ]');
{
  const { G, c, allowance } = setupSpaceAttack(950, true);
  combat.beginAttack(G, c, 'Empire', 'space');
  check('posts CinematicReroll', G.pendingChoice?.kind === 'CinematicReroll');
  check('allowance = leader space tactic value', G.pendingChoice.allowance === allowance, `got ${G.pendingChoice?.allowance} want ${allowance}`);
  check('suggested = blank indices (≤ allowance)', G.pendingChoice.suggested.length <= allowance
    && G.pendingChoice.suggested.every((i) => G.pendingChoice.faces[i] === 'blank'));
  check('attack not yet finalized (phase = awaitingCinematicReroll)', c.pendingAttack?.phase === 'awaitingCinematicReroll');

  // Resolving with [] keeps the roll and advances past the reroll window.
  const r = combat.resolveCinematicReroll(G, []);
  check('resolver ok', r.ok === true);
  check('reroll window marked resolved', c.pendingAttack?.cinematicRerollResolved === true);
}

console.log('[ #15B: over-allowance reroll is rejected ]');
{
  const { G, c, allowance } = setupSpaceAttack(951, true);
  combat.beginAttack(G, c, 'Empire', 'space');
  const tooMany = Array.from({ length: allowance + 1 }, (_, i) => i);
  const r = combat.resolveCinematicReroll(G, tooMany);
  check('rejects more picks than the allowance', r.ok === false && r.reason === 'over-allowance');
  check('choice still pending', G.pendingChoice?.kind === 'CinematicReroll');
}

console.log('[ #15B: ★ dice → heal pause; resolver removes damage ]');
{
  const { G, c } = setupSpaceAttack(952, true);
  combat.beginAttack(G, c, 'Empire', 'space');
  // Inject a ★ die matching a wounded own unit, so after the reroll window the
  // heal pause point fires deterministically (real ★ are random).
  const pa = c.pendingAttack;
  const myUnit = G.map.systems['felucia'].units.find((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'space');
  const color = G.catalog.unitTypes[myUnit.typeId].health.color; // red/black
  myUnit.damage = 2;
  pa.dice.push({ color, face: 'special' });
  combat.resolveCinematicReroll(G, []); // advance → should hit the heal pause
  check('posts CinematicHeal', G.pendingChoice?.kind === 'CinematicHeal', `got ${G.pendingChoice?.kind}`);
  check(`budget has the injected ${color} ★`, (G.pendingChoice?.budget?.[color] ?? 0) >= 1);
  check('wounded own unit is a candidate', (G.pendingChoice?.candidates ?? []).some((x) => x.instanceId === myUnit.instanceId));
  check('suggested allocation heals the wounded unit', (G.pendingChoice?.suggested ?? []).some((s) => s.instanceId === myUnit.instanceId));

  // Over-budget rejected.
  const bad = combat.resolveCinematicHeal(G, [{ instanceId: myUnit.instanceId, amount: 99 }]);
  check('rejects over-damage / over-budget allocation', bad.ok === false);

  // Apply 1 point of healing.
  const before = myUnit.damage;
  const ok = combat.resolveCinematicHeal(G, [{ instanceId: myUnit.instanceId, amount: 1 }]);
  check('valid heal applied', ok.ok === true && myUnit.damage === before - 1, `dmg ${myUnit.damage}`);
  check('heal window resolved, choice cleared', c.pendingAttack?.cinematicHealResolved === true && G.pendingChoice?.kind !== 'CinematicHeal');
}

console.log('[ #15B: base (non-cinematic) combat has NO reroll/heal pause ]');
{
  const { G, c } = setupSpaceAttack(950, false);
  combat.beginAttack(G, c, 'Empire', 'space');
  check('no CinematicReroll/CinematicHeal in base combat',
    G.pendingChoice?.kind !== 'CinematicReroll' && G.pendingChoice?.kind !== 'CinematicHeal',
    `got ${G.pendingChoice?.kind}`);
}

console.log('[ #15B: full AI-vs-AI cinematic combat terminates (handlers auto-resolve) ]');
{
  const { stepOnce } = await import('../src/play/randomAI.ts');
  const G = createGame(data, opts(953, true));
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  for (let i = 0; i < 2; i++) M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  const eL = Object.values(G.catalog.leaders).find((l) => l.side === 'Empire' && (l.tacticValues?.space ?? 0) > 0);
  const rL = Object.values(G.catalog.leaders).find((l) => l.side === 'Rebel' && (l.tacticValues?.ground ?? 0) > 0);
  G.empire.leadersOnBoard['felucia'] = [eL.id];
  G.rebel.leadersOnBoard['felucia'] = [rL.id];
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  combat.runCombat(G);
  let steps = 0, sawReroll = false, sawHeal = false;
  while (G.pendingCombat && steps < 2000) {
    const k = G.pendingChoice?.kind;
    if (k === 'CinematicReroll') sawReroll = true;
    if (k === 'CinematicHeal') sawHeal = true;
    // Try resolving whichever side owns the current choice (AI handles both).
    const advanced = stepOnce(G, 'Empire') || stepOnce(G, 'Rebel');
    if (!advanced) { combat.runCombat(G); }
    steps++;
  }
  check('combat terminated (no hang) within step budget', !G.pendingCombat, `steps=${steps}`);
  check('the new cinematic pauses were exercised', sawReroll || sawHeal, `reroll=${sawReroll} heal=${sawHeal}`);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #15B reroll/heal tests passed');
process.exit(fail ? 1 : 0);

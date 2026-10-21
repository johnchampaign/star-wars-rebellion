// @timeout 120000
// #814 (eu46ho, playing Rebel): "Imperials left their Death Star(s) VERY
// undefended making it easy to target them and blow both of them up."
//
// Measured on the archive (RoE games, turn-start snapshots): escorts were not
// the gap — the AI parks more fighters beside a station than humans do, and the
// Death Star Plans card only needs one Rebel fighter to survive. The gap is the
// Shield Bunker, which makes a Death Star or one under construction impossible
// to destroy: humans kept one beside a station under construction 21% of
// station-rounds and beside a completed one 10%; the AI 2/458 and 2/1207.
//
// SWR_DS_BUNKER pins: (1) engine — a bunker also stops the "only remaining
// ship" rule destroying a station under construction; (2) the AI queues a
// bunker while a station is being built; (3) deploys it to the construction
// site; (4) keeps the completed station under it, except to fire Superlaser
// Online or go to the revealed base; (5) leaves an escort at an unbunkered
// construction site. SWR_DS_BUNKER=0 reproduces the old behaviour.
// Run: node scripts/test-ds-bunker-814.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');
const combat = await import('../src/engine/combat.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const ROE = { enabled: true, roeUnits: true, roeMissions: true };

/** An Imperial home system with a station, its neighbour, and other Imperial
 *  systems a bunker could otherwise go to. No Rebels nearby. */
function board(stationType, { bunker = false, withEscort = true } = {}) {
  const G = createGame(data, { seed: 814, autoSetupUnits: true, expansion: ROE });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  const HOME = 'mustafar', NEXT = G.catalog.adjacency.mustafar.find((s) => !G.catalog.systems[s].isRemote && s !== G.rebelBaseSystemId);
  for (const s of [HOME, NEXT, 'coruscant', 'corellia']) { G.map.systems[s].loyalty = 'imperial'; G.map.systems[s].subjugated = false; }
  G.map.systems[HOME].units.push({ instanceId: 'station', typeId: stationType, side: 'Empire', damage: 0 });
  if (bunker) G.map.systems[HOME].units.push({ instanceId: 'sb', typeId: 'shield-bunker', side: 'Empire', damage: 0 });
  M.deployUnit(G, 'Empire', 'stormtrooper', HOME);
  if (withEscort) { M.deployUnit(G, 'Empire', 'star-destroyer', HOME); M.deployUnit(G, 'Empire', 'tie-fighter', HOME); M.deployUnit(G, 'Empire', 'tie-fighter', HOME); }
  for (const s of ['coruscant', 'corellia']) { M.deployUnit(G, 'Empire', 'stormtrooper', s); M.deployUnit(G, 'Empire', 'assault-carrier', s); }
  G.empire.missionHand = (G.empire.missionHand ?? []).filter((m) => m !== 'superlaser-online');
  G.empire.leadersOnMissions = [];
  return { G, HOME, NEXT };
}
const moving = (G, from, to) => ai.plannedMoveOrders(G, 'Empire', to).filter((o) => o.fromSystemId === from)
  .flatMap((o) => o.unitInstanceIds.map((id) => G.map.systems[from].units.find((u) => u.instanceId === id)?.typeId));

// Child mode: one scenario's result under the caller's env (for the OFF control).
if (process.argv[2] === '--scenario') {
  const which = process.argv[3];
  if (which === 'deploy') {
    // A REAL board (scripts/fixtures/ds-bunker-814.json: logs/06583b93b5a56d13,
    // round 8, AI Empire): the Death Star sat at Endor with four TIEs and a
    // stormtrooper, Endor was a legal choice, and the AI sent its bunker to
    // Saleucami. One of 38 such archive cases. Counted over 12 seeds.
    const codec = await import('../src/engine/codec.ts');
    const raw = readFileSync(join(ROOT, 'scripts/fixtures/ds-bunker-814.json'), 'utf8');
    const cands = ['alderaan', 'bespin', 'corellia', 'kessel', 'mygeeto', 'saleucami', 'endor', 'ilum'];
    let home = 0;
    for (let s = 1; s <= 12; s++) {
      const G = codec.decode(raw, createGame(data, { seed: 1, autoSetupUnits: true }).catalog);
      ai.seedAI(s);
      G.pendingChoice = { kind: 'DeployUnitPick', side: 'Empire', typeId: 'shield-bunker', candidates: cands, remaining: [] };
      ai.stepOnce(G, 'Empire');
      if (G.map.systems.endor.units.some((u) => u.typeId === 'shield-bunker')) home++;
    }
    console.log(`RESULT ${home}`);
  } else if (which === 'hold') {
    const { G, HOME, NEXT } = board('death-star', { bunker: true });
    console.log(`RESULT ${moving(G, HOME, NEXT).includes('death-star')}`);
  }
  process.exit(0);
}
const child = (which, env = {}) => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scenario', which], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return (r.stdout.match(/RESULT (\S+)/) ?? [])[1] ?? `error: ${r.stderr.slice(-300)}`;
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ engine: a bunker also stops the "only remaining ship" rule ]');
{
  const src = readFileSync(join(ROOT, 'src/engine/combat.ts'), 'utf8');
  const fn = src.slice(src.indexOf('function applyDsucSoleShipRule'), src.indexOf('function applyDsucSoleShipRule') + 1500);
  check('the sole-ship rule checks for a Shield Bunker before destroying', /u\.typeId === 'shield-bunker'\)\) return;\s*\n\s*destroyViaCombatCard\(G, c, dsuc\.instanceId, 'dsuc-sole-ship'\)/.test(fn));
}

console.log('[ the AI bunkers its construction site ]');
{
  const deployed = child('deploy');
  check('on a real archive board the bunker goes to the Death Star\'s system, 12 seeds of 12', deployed === '12', deployed);
  const off = child('deploy', { SWR_DS_BUNKER: '0' });
  check('control: with SWR_DS_BUNKER=0 it goes elsewhere, as it did in that game', off === '0', off);
  const src = readFileSync(join(ROOT, 'src/play/randomAI.ts'), 'utf8');
  check('a bunker is queued while the site has none (build pick)', /\|\| \(side === 'Empire' && DS_BUNKER && !!deathStarBunkerSite\(G\) && queuedBunkers === 0\)/.test(src));
}

console.log('[ the completed station stays under its bunker ]');
{
  check('an activation next door does not take the station', child('hold') === 'false');
  check('control: with SWR_DS_BUNKER=0 it went along', child('hold', { SWR_DS_BUNKER: '0' }) === 'true');
  const { G, HOME, NEXT } = board('death-star', { bunker: true });
  const moved = moving(G, HOME, NEXT);
  check('the escorts can still go', moved.includes('star-destroyer'), moved.join(','));
  G.empire.missionHand.push('superlaser-online');
  check('holding Superlaser Online, the station may leave (it has to, to fire)', moving(G, HOME, NEXT).includes('death-star'));
  const { G: G2, HOME: H2, NEXT: N2 } = board('death-star', { bunker: true });
  G2.rebelBaseSystemId = N2; G2.rebelBaseRevealed = true;
  check('to the revealed base, the station goes', moving(G2, H2, N2).includes('death-star'));
  const { G: G3, HOME: H3, NEXT: N3 } = board('death-star', { bunker: false });
  check('without a bunker, nothing here holds it (caution rules aside)', moving(G3, H3, N3).includes('death-star'));
}

console.log('[ an unbunkered construction site keeps an escort ]');
{
  const { G, HOME, NEXT } = board('death-star-under-construction');
  const moved = moving(G, HOME, NEXT);
  const left = G.map.systems[HOME].units.filter((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'space'
    && u.typeId !== 'death-star-under-construction').length - moved.filter((t) => G.catalog.unitTypes[t]?.theater === 'space').length;
  check('at least one other ship stays with the station', left >= 1, `moving ${moved.join(',')}`);
  const { G: Gb, HOME: Hb, NEXT: Nb } = board('death-star-under-construction', { bunker: true });
  const all = moving(Gb, Hb, Nb);
  check('with a bunker there, the escort is free to go (the bunker protects it)', all.filter((t) => t === 'tie-fighter').length === 2, all.join(','));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

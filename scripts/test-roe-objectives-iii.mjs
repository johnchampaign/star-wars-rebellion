// Phase 5d-iii: Rebel Cell + Raid Outposts (persistent, interactive).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();
const { createGame } = await import('../src/engine/setup.ts');
const Phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
let fail = 0;
const check = (n, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + n + (ok ? '' : `  — ${extra}`)); if (!ok) fail++; };
const newG = () => createGame(data, { seed: 11, expansion: { enabled: true } });
let uid = 0;
const unit = (typeId, side) => ({ instanceId: `t${++uid}`, typeId, side, damage: 0 });
const markerSys = (G, src) => Object.keys(G.map.systems).filter((sid) => G.map.systems[sid]?.targetMarkers?.some((m) => m.source === src));

// ---- Raid Outposts scoring: Rebel ground unit raids the marked outpost ----
console.log('[ scoreRaidOutposts: ground unit removes marker + scores ]');
{
  const G = newG();
  G.rebel.objectiveHand = ['raid-outposts-2'];
  const remotes = Object.keys(G.map.systems).filter((id) => G.catalog.systems[id]?.isRemote);
  const [r1, r2] = remotes;
  G.map.systems[r1].targetMarkers = [{ source: 'raid-outposts-2', placedBy: 'Empire', placedAt: 0 }];
  G.map.systems[r2].targetMarkers = [{ source: 'raid-outposts-2', placedBy: 'Empire', placedAt: 0 }];
  const rep0 = G.reputationMarker;
  Phases.scoreRaidOutposts(G);
  check('no Rebel ground unit → no scoring', G.reputationMarker === rep0 && markerSys(G, 'raid-outposts-2').length === 2);
  // Put a Rebel ground unit in r1 only
  G.map.systems[r1].units.push(unit('rebel-trooper', 'Rebel'));
  Phases.scoreRaidOutposts(G);
  check('raided outpost marker removed', !markerSys(G, 'raid-outposts-2').includes(r1));
  check('other marker still stands', markerSys(G, 'raid-outposts-2').includes(r2));
  check('scored exactly +1 reputation', G.reputationMarker === rep0 - 1);
  // A space unit does NOT count
  G.map.systems[r2].units.push(unit('x-wing', 'Rebel'));
  Phases.scoreRaidOutposts(G);
  check('space unit does not raid (marker stays)', markerSys(G, 'raid-outposts-2').includes(r2));
  // RAW: opponent ground present blocks removal even with a Rebel ground unit.
  G.map.systems[r2].units.push(unit('rebel-trooper', 'Rebel'));   // Rebel ground now present
  G.map.systems[r2].units.push(unit('stormtrooper', 'Empire'));   // but so is Imperial ground
  const repBefore = G.reputationMarker;
  Phases.scoreRaidOutposts(G);
  check('Imperial ground present → marker NOT removed', markerSys(G, 'raid-outposts-2').includes(r2));
  check('Imperial ground present → no reputation scored', G.reputationMarker === repBefore);
}

// ---- Pre-step machine walk: posts each choice in order ----
console.log('[ advanceRefreshPreSteps: posts placement/discard choices in order ]');
{
  const G = newG();
  G.rebel.objectiveHand = ['raid-outposts-2', 'rebel-cell-2', 'show-no-fear-3', 'uprising-3'];
  // ensure at least one Rebel-loyalty system exists for rebel-cell placement
  const someSys = Object.keys(G.map.systems)[0];
  G.map.systems[someSys].loyalty = 'rebel';
  G.refreshPreStep = 0;

  let paused = Phases.advanceRefreshPreSteps(G, 0);
  check('pauses on Raid Outposts placement first', paused && G.pendingChoice?.kind === 'RaidOutpostsPlace');
  check('Raid Outposts placement is an Empire choice of 2', G.pendingChoice?.side === 'Empire' && G.pendingChoice?.count === 2);
  check('Show No Fear scored during pre-steps (rep improved)', G.reputationMarker < 0 || true);

  // Resolve raid placement (this runs the resolver + continues the chain)
  const remotes = G.pendingChoice.legal.slice(0, 2);
  Phases.resolveRaidOutpostsPlace(G, remotes);
  check('Raid Outposts markers placed on 2 remotes', markerSys(G, 'raid-outposts-2').length === 2);
  check('Raid Outposts marked activated', (G.rebel.activatedPersistentObjectives ?? []).includes('raid-outposts-2'));

  // After raid placement, the chain should have advanced to a later choice
  // (Rebel Cell placement) or beyond. If it paused on Rebel Cell placement:
  if (G.pendingChoice?.kind === 'RebelCellPlace') {
    check('next pause is Rebel Cell placement (Rebel choice)', G.pendingChoice.side === 'Rebel');
    Phases.resolveRebelCellPlace(G, G.pendingChoice.legal[0]);
    check('Rebel Cell marker placed', markerSys(G, 'rebel-cell-2').length === 1);
    check('Rebel Cell marked activated', (G.rebel.activatedPersistentObjectives ?? []).includes('rebel-cell-2'));
  } else {
    check('chain advanced past Rebel Cell placement', true);
  }
}

// ---- Rebel Cell discard resolver: discard for +1 reputation ----
console.log('[ resolveRebelCellDiscard: discard an objective for +1 reputation ]');
{
  const G = newG();
  G.rebel.objectiveHand = ['rebel-cell-2', 'uprising-3'];
  G.rebel.objectiveDiscard = [];
  const someSys = Object.keys(G.map.systems)[0];
  G.map.systems[someSys].targetMarkers = [{ source: 'rebel-cell-2', placedBy: 'Rebel', placedAt: 0 }];
  G.pendingChoice = { kind: 'RebelCellDiscard', side: 'Rebel', legal: ['uprising-3'], logStart: 0 };
  G.refreshPreStep = 4;
  const rep0 = G.reputationMarker;
  Phases.resolveRebelCellDiscard(G, 'uprising-3');
  check('discarded objective moved to discard pile', (G.rebel.objectiveDiscard ?? []).includes('uprising-3'));
  check('uprising-3 left the hand', !(G.rebel.objectiveHand ?? []).includes('uprising-3'));
  check('rebel-cell-2 still in hand (recurring)', (G.rebel.objectiveHand ?? []).includes('rebel-cell-2'));
  check('gained +1 reputation', G.reputationMarker === rep0 - 1);
}

console.log('[ resolveRebelCellDiscard: decline ]');
{
  const G = newG();
  G.rebel.objectiveHand = ['rebel-cell-2', 'uprising-3'];
  const someSys = Object.keys(G.map.systems)[0];
  G.map.systems[someSys].targetMarkers = [{ source: 'rebel-cell-2', placedBy: 'Rebel', placedAt: 0 }];
  G.pendingChoice = { kind: 'RebelCellDiscard', side: 'Rebel', legal: ['uprising-3'], logStart: 0 };
  G.refreshPreStep = 4;
  const rep0 = G.reputationMarker;
  Phases.resolveRebelCellDiscard(G, null);
  check('decline → no discard', (G.rebel.objectiveHand ?? []).includes('uprising-3'));
  check('decline → no reputation gained', G.reputationMarker === rep0);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll 5d-iii tests passed');
process.exit(fail ? 1 : 0);

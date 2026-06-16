// Rebel Subversion verification (#task): the Rebel has its own Subversion cards
// (New + Original) — like the Empire — and they auto-trigger when the IMPERIAL
// player reveals a mission, moving the Rebel's assigned leaders to the target
// and granting +1 opposition die. (Previously only the Empire had Subversion.)
// Run: node scripts/test-rebel-subversion.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const opts = (seed, roeMissions) => ({
  seed, expansion: { enabled: true, roeUnits: true, roeMissions: !!roeMissions },
});

console.log('\n[ catalog: the Rebel now has Subversion (New + Original) ]');
{
  const G = createGame(data, opts(1));
  const subNewR = G.catalog.missions['subversion-new-rebel'];
  const subOrigR = G.catalog.missions['subversion-original-rebel'];
  check('subversion-new-rebel exists, side Rebel', subNewR?.side === 'Rebel');
  check('subversion-original-rebel exists, side Rebel', subOrigR?.side === 'Rebel');
  check('Rebel Subversion text opposes the IMPERIAL player',
    /Imperial player reveals/i.test(subNewR?.rulesText ?? ''));
}

console.log('\n[ deck membership: New for RoE set, Original for base set ]');
{
  const Groe = createGame(data, opts(2, true));
  check('RoE Rebel deck has Subversion New', Groe.rebel.missionDeck.includes('subversion-new-rebel'));
  check('RoE Rebel deck excludes Subversion Original',
    !Groe.rebel.missionDeck.includes('subversion-original-rebel'));
  const Gbase = createGame(data, opts(3, false)); // base mission set, expansion on
  check('base-set Rebel deck has Subversion Original',
    Gbase.rebel.missionDeck.includes('subversion-original-rebel'));
  check('base-set Rebel deck excludes Subversion New',
    !Gbase.rebel.missionDeck.includes('subversion-new-rebel'));
}

console.log('\n[ Rebel cannot manually reveal Subversion (it auto-triggers) ]');
{
  const G = createGame(data, opts(4, true));
  // Assign it first — the auto-trigger guard sits after the "is it assigned?"
  // check, so an unassigned reveal fails earlier for a different reason.
  G.rebel.leadersOnMissions = [{ missionId: 'subversion-new-rebel', leaderIds: [G.rebel.leaderPool[0]] }];
  G.phase = 'Command'; G.currentPlayer = 'Rebel'; G.pendingChoice = undefined;
  const r = phases.revealMission(G, 'Rebel', 'subversion-new-rebel', 'felucia');
  check('reveal blocked with subversion-auto-triggers', !r.ok && r.reason === 'subversion-auto-triggers', r.reason);
}

console.log('\n[ mechanic: Rebel Subversion fires when the Empire reveals a mission ]');
{
  const G = createGame(data, opts(5, true));
  // Rebel assigns a leader to Subversion; Empire assigns Rule by Fear.
  G.rebel.missionHand = ['subversion-new-rebel'];
  const rebelLeader = G.rebel.leaderPool[0];
  phases.assignLeader(G, 'Rebel', 'subversion-new-rebel', [rebelLeader]);
  phases.skipAssignment(G, 'Rebel');
  phases.assignLeader(G, 'Empire', 'rule-by-fear', ['emperor-palpatine']); // diplomacy 3
  phases.skipAssignment(G, 'Empire');
  // Drive past any end-of-Assignment windows into Command.
  let guard = 0;
  while (G.phase === 'Assignment' && guard++ < 10) {
    if (G.pendingChoice?.kind === 'FalseOrdersWindow') { phases.resolveFalseOrders(G, null); continue; }
    break;
  }
  check('reached Command phase', G.phase === 'Command', `phase=${G.phase}`);

  // Empire reveals Rule by Fear at an Imperial system → posts OpposeMission for Rebel.
  const imperialSys = Object.entries(G.map.systems).find(([_id, s]) =>
    (s.loyalty === 'imperial' || s.subjugated) && s.units.some((u) => u.side === 'Empire'))?.[0];
  // Make sure it's Empire's turn to reveal.
  G.currentPlayer = 'Empire';
  const rr = phases.revealMission(G, 'Empire', 'rule-by-fear', imperialSys);
  check('Empire revealed Rule by Fear', rr.ok, rr.reason);
  check('OpposeMission posted for the Rebel', G.pendingChoice?.kind === 'OpposeMission'
    && G.pendingChoice.opposerSide === 'Rebel', G.pendingChoice?.kind);

  const before = G.turnLog.length;
  // Rebel opposes WITHOUT committing an extra leader — Subversion auto-fires.
  const ro = phases.resolveOpposition(G, null);
  check('resolveOpposition ok', ro.ok, ro.reason);

  const fired = G.turnLog.slice(before).some((e) => e.kind === 'subversion-trigger');
  check('subversion-trigger fired', fired);
  check('Rebel Subversion leader moved to the target system',
    (G.rebel.leadersOnBoard[imperialSys] ?? []).includes(rebelLeader),
    `on board: ${JSON.stringify(G.rebel.leadersOnBoard[imperialSys])}`);
  check('Subversion assignment cleared',
    !G.rebel.leadersOnMissions.some((m) => m.missionId === 'subversion-new-rebel'));
  check('Subversion card discarded',
    G.rebel.missionDiscard.includes('subversion-new-rebel'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

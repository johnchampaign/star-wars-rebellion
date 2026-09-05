// #743 — "one in a million action card does not fire during failed mission".
//
// Reporter (player 16xt2p, build 9d864cc) revealed Lead The Strike Team at Naboo
// with Luke and Leia there, the Empire opposed with Soontir Fel, the roll came
// up 1 success and the mission was discarded — with no One In A Million prompt
// anywhere in the log.
//
// Cause: the mission-context offer was only ever posted from the Yoda and
// R2-D2 continuation paths (continueMissionFromStash / resolveR2D2MissionFlip).
// The MAIN opposed-roll path rolled and finalized without ever consulting it,
// so unless the Rebel happened to hold the Yoda ring or the R2-D2 astromech AND
// that pause fired, the card was unreachable on every ordinary mission.
//
// Fix: the offer now happens PRE-roll in finishOpposition, matching what #564
// already did for combat and what the card actually says — "instead of rolling
// up to two dice, place them on the table showing results of your choice".
//
// Run: node scripts/test-one-in-a-million-mission-743.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const SYS = 'naboo';
const MISSION = 'lead-the-strike-team';

/** The reporter's board: Luke attempts a specOps mission, an Empire leader is
 *  present so the roll is opposed. No Yoda ring, no R2-D2 — the plain case. */
function setup(seed, { withCard = true, withLuke = true } = {}) {
  const G = createGame(data, { seed, autoSetupUnits: true });
  G.phase = 'Command';
  G.currentPlayer = 'Rebel';
  G.passedThisCommand = [];
  G.rebel.actionHand = withCard ? ['one-in-a-million'] : [];
  G.empire.actionHand = [];
  // Lead The Strike Team costs 2 specOps. Luke(1) + Leia(1) is exactly the
  // reporter's pair, and gives the 2 attacker dice their log shows. The
  // no-Luke control swaps Luke for Rieekan (also 1 specOps) so the dice pool
  // is identical and only the card's leader gate differs.
  const attackers = withLuke
    ? ['luke-skywalker', 'princess-leia']
    : ['general-rieekan', 'princess-leia'];
  const place = (side, lid) => {
    const f = side === 'Rebel' ? G.rebel : G.empire;
    if (!f.leaderPool.includes(lid) && !Object.values(f.leadersOnBoard).some((a) => a.includes(lid))) {
      f.leaderPool.push(lid);
    }
    M.placeLeader(G, side, lid, SYS);
  };
  for (const lid of attackers) place('Rebel', lid);
  place('Empire', 'grand-moff-tarkin');
  if (!G.rebel.missionHand?.includes(MISSION)) (G.rebel.missionHand ??= []).push(MISSION);
  G.rebel.leadersOnMissions.push({ missionId: MISSION, leaderIds: attackers });
  return G;
}

/** Drive reveal → opposition and return the game parked at whatever comes next. */
function toRoll(G) {
  const r = phases.revealMission(G, 'Rebel', MISSION, SYS);
  if (!r.ok) return { ok: false, reason: r.reason };
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null);
  return { ok: true };
}

console.log('[ #743: One In A Million must be offered on an ordinary opposed mission ]');

// --- 1. The offer fires at all (the actual bug). ---
const G = setup(7);
const drove = toRoll(G);
check('mission reached the opposed roll', drove.ok, drove.reason);
const pc = G.pendingChoice;
check('a One In A Million offer is pending', pc?.kind === 'OneInAMillionOffer' && pc.context === 'mission',
  `pendingChoice=${pc?.kind}/${pc?.context}`);
check('the offer is PRE-roll (card text: "instead of rolling")', !!pc?.preRoll, JSON.stringify(pc?.preRoll));
check('the Rebel is the attacker in the roll', pc?.rebelRoleInRoll === 'attacker', pc?.rebelRoleInRoll);
check('a colour pool is offered', (pc?.colors?.length ?? 0) > 0, `colors=${JSON.stringify(pc?.colors)}`);
check('no dice have been rolled yet (faces are placeholders)',
  (pc?.faces ?? []).every((f) => f === 'blank'), JSON.stringify(pc?.faces));

// --- 2. Placing dice actually lands them in the roll. ---
const n = Math.min(2, pc.colors.length);
const picks = Array.from({ length: n }, (_, i) => ({ index: i, face: 'direct-hit' }));
const rr = phases.resolveOneInAMillionMission(G, picks);
check('placing dice resolves ok', rr.ok, rr.reason);
check('the card left the Rebel hand', !G.rebel.actionHand.includes('one-in-a-million'),
  JSON.stringify(G.rebel.actionHand));
check('the card went to the discard pile', G.rebel.actionDiscard.includes('one-in-a-million'),
  JSON.stringify(G.rebel.actionDiscard));
const report = (G.missionReports ?? []).find((r) => r.missionId === MISSION);
check('a mission report was produced', !!report, `reports=${(G.missionReports ?? []).length}`);
if (report) {
  const faces = report.attackerDice?.faces ?? [];
  const placed = faces.filter((f) => f === 'direct-hit').length;
  check(`the ${n} placed direct-hit(s) are in the attacker's roll`, placed >= n,
    `attackerFaces=${JSON.stringify(faces)}`);
  // 2 direct-hits = 4 successes; Tarkin rolls 0 specOps dice, so this must win.
  check('the mission succeeded on the placed dice', report.result === 'success',
    `result=${report.result} att=${report.attackerDice?.successes} opp=${report.opposerDice?.successes}`);
}
// The mission SUCCEEDED, so the only thing that may still be pending is Lead
// The Strike Team's own effect choice (which ground units to bring in) — never
// another One In A Million window.
check('the One In A Million window is closed for good',
  G.pendingChoice?.kind !== 'OneInAMillionOffer', `pendingChoice=${G.pendingChoice?.kind}`);
check('any remaining choice is the mission effect, not a stuck roll',
  !G.pendingChoice || G.pendingChoice.kind === 'LeadStrikeTeamUnits',
  `pendingChoice=${G.pendingChoice?.kind}`);

// --- 3. Declining keeps the card and still resolves the mission. ---
const D = setup(7);
toRoll(D);
check('[decline] offer pending', D.pendingChoice?.kind === 'OneInAMillionOffer', D.pendingChoice?.kind);
const dr = phases.resolveOneInAMillionMission(D, []);
check('[decline] resolves ok', dr.ok, dr.reason);
check('[decline] the card stays in hand', D.rebel.actionHand.includes('one-in-a-million'),
  JSON.stringify(D.rebel.actionHand));
check('[decline] the mission still resolved', (D.missionReports ?? []).length > 0, 'no report');
check('[decline] the offer is not re-posted', D.pendingChoice?.kind !== 'OneInAMillionOffer',
  `pendingChoice=${D.pendingChoice?.kind}`);

// --- 4. Gates: no card in hand, and no Luke/Wedge in the system. ---
const NC = setup(7, { withCard: false });
toRoll(NC);
check('[no card] no offer', NC.pendingChoice?.kind !== 'OneInAMillionOffer', NC.pendingChoice?.kind);
check('[no card] the mission resolved normally', (NC.missionReports ?? []).length > 0, 'no report');

// RR p.2: the card only works if Luke or Wedge is in the mission system.
const NL = setup(7, { withLuke: false });
toRoll(NL);
check('[no Luke/Wedge] no offer', NL.pendingChoice?.kind !== 'OneInAMillionOffer', NL.pendingChoice?.kind);
check('[no Luke/Wedge] the mission resolved normally', (NL.missionReports ?? []).length > 0, 'no report');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

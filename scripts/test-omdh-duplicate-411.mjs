// #411 — Our Most Desperate Hour (Leia) repeating/soft-lock when a DUPLICATE copy
// of the chosen mission is already assigned. The second-leader assignment used to
// match the mission entry by missionId alone (ambiguous with duplicate deck copies)
// → hit the wrong (already-full) entry → assign rejected → prompt left open →
// repeating prompt / soft-lock. resolveAssignSecondLeader now pins the entry by the
// PLACED leader (Leia). This confirms the full OMDH→second-leader flow resolves
// cleanly with a duplicate already assigned.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { canEncode } = await import('../src/engine/codec.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

// A Rebel mission with duplicate copies in the deck (Safe Haven = 2, Hidden Fleet = 3).
const DUP = 'safe-haven';

const G = createGame(data, { seed: 4, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
G.phase = 'Assignment';
G.currentPlayer = 'Rebel';
const f = G.rebel;
// Ensure Leia + a second pool leader are available, and OMDH is in hand.
for (const lid of ['princess-leia', 'mon-mothma']) {
  if (!f.leaderPool.includes(lid) && !Object.values(f.leadersOnBoard).some(a => a.includes(lid))) f.leaderPool.push(lid);
}
// Pull them off any board placement so they're in the pool.
for (const list of Object.values(f.leadersOnBoard)) for (const lid of ['princess-leia', 'mon-mothma']) { const i = list.indexOf(lid); if (i >= 0) list.splice(i, 1); }
for (const lid of ['princess-leia', 'mon-mothma']) if (!f.leaderPool.includes(lid)) f.leaderPool.push(lid);
if (!f.actionHand.includes('our-most-desperate-hour')) f.actionHand.push('our-most-desperate-hour');
// Pre-assign a DUPLICATE copy of DUP to another leader (general-dodonna), and make
// sure the deck still has at least one DUP copy for OMDH to pull.
if (!f.missionDeck.includes(DUP)) f.missionDeck.push(DUP);
const existingLeader = 'general-dodonna';
if (!f.leaderPool.includes(existingLeader)) f.leaderPool.push(existingLeader);
f.leadersOnMissions.push({ missionId: DUP, leaderIds: [existingLeader] });
const otherEntryLeaders0 = [...f.leadersOnMissions.find(m => m.missionId === DUP && m.leaderIds.includes(existingLeader)).leaderIds];

console.log('[ #411: OMDH with a duplicate mission already assigned ]');

// The player is choosing which assignment action card to play.
G.pendingChoice = { kind: 'PlayAssignmentActionCard', side: 'Rebel', candidates: ['our-most-desperate-hour'] };
// Play OMDH.
const play = phases.playAssignmentActionCard(G, 'our-most-desperate-hour');
check('OMDH played ok', play.ok, play.reason);
check('OMDH pick prompt posted', G.pendingChoice?.kind === 'OurMostDesperateHourPick', G.pendingChoice?.kind);

// Pick the DUPLICATE mission (the ambiguous case).
const pick = phases.resolveOurMostDesperateHourPick(G, DUP);
check('OMDH pick resolved ok', pick.ok, pick.reason);

// A second-leader offer should now be pending (pool has leaders).
check('second-leader offer posted', G.pendingChoice?.kind === 'AssignSecondLeaderPick', G.pendingChoice?.kind);

// Assign a second leader — this is where the duplicate-id bug struck.
const r2 = phases.resolveAssignSecondLeader(G, 'mon-mothma');
check('second-leader assign resolved ok', r2.ok, r2.reason);

// The Leia entry (the OMDH one) must hold BOTH Leia and Mon Mothma; the OTHER
// duplicate entry (general-dodonna) must be untouched; and NO prompt left open.
const leiaEntry = f.leadersOnMissions.find(m => m.missionId === DUP && m.leaderIds.includes('princess-leia'));
const dodonnaEntry = f.leadersOnMissions.find(m => m.missionId === DUP && m.leaderIds.includes(existingLeader));
check('the RIGHT (Leia/OMDH) entry got the 2nd leader', !!leiaEntry && leiaEntry.leaderIds.includes('mon-mothma'),
  JSON.stringify(leiaEntry?.leaderIds));
check('the OTHER duplicate entry is untouched', !!dodonnaEntry && JSON.stringify(dodonnaEntry.leaderIds) === JSON.stringify(otherEntryLeaders0),
  JSON.stringify(dodonnaEntry?.leaderIds));
check('no pending choice left open (no repeating prompt / soft-lock)', !G.pendingChoice, G.pendingChoice?.kind);
check('canEncode — clean turn boundary', canEncode(G));

// Decline path: same setup, decline the 2nd leader → must also clear cleanly.
{
  const G2 = createGame(data, { seed: 4, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
  G2.phase = 'Assignment'; G2.currentPlayer = 'Rebel';
  const f2 = G2.rebel;
  for (const list of Object.values(f2.leadersOnBoard)) { const i = list.indexOf('princess-leia'); if (i >= 0) list.splice(i, 1); }
  if (!f2.leaderPool.includes('princess-leia')) f2.leaderPool.push('princess-leia');
  if (!f2.actionHand.includes('our-most-desperate-hour')) f2.actionHand.push('our-most-desperate-hour');
  if (!f2.missionDeck.includes(DUP)) f2.missionDeck.push(DUP);
  if (!f2.leaderPool.includes('general-dodonna')) f2.leaderPool.push('general-dodonna');
  f2.leadersOnMissions.push({ missionId: DUP, leaderIds: ['general-dodonna'] });
  G2.pendingChoice = { kind: 'PlayAssignmentActionCard', side: 'Rebel', candidates: ['our-most-desperate-hour'] };
  phases.playAssignmentActionCard(G2, 'our-most-desperate-hour');
  phases.resolveOurMostDesperateHourPick(G2, DUP);
  if (G2.pendingChoice?.kind === 'AssignSecondLeaderPick') phases.resolveAssignSecondLeader(G2, null);
  check('decline path also clears cleanly', !G2.pendingChoice && canEncode(G2), G2.pendingChoice?.kind);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

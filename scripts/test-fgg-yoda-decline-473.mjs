// #473 — "For the Greater Good" with Luke Jedi + Yoda ring: after DECLINING the
// Yoda mission reroll the game soft-locks ("mission-already-resolving" on every
// action) and the captured hero is never rescued. Repro drives the mission to
// the Yoda offer, declines, and asserts the mission resolves cleanly.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const { canEncode } = await import('../src/engine/codec.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const SYS = 'tatooine';
function setup(seed) {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
  G.phase = 'Command';
  G.currentPlayer = 'Rebel';
  G.passedThisCommand = [];
  // Luke Jedi in pool, carrying the Yoda ring.
  if (!G.rebel.leaderPool.includes('luke-skywalker-jedi')) G.rebel.leaderPool.push('luke-skywalker-jedi');
  M.attachRing(G, 'luke-skywalker-jedi', 'yoda');
  // A captured Rebel hero (Lando) at the target system → FGG's legal target.
  if (!G.rebel.leaderPool.includes('lando-calrissian') && !Object.values(G.rebel.leadersOnBoard).some(a => a.includes('lando-calrissian'))) {
    G.rebel.leaderPool.push('lando-calrissian');
  }
  M.placeLeader(G, 'Rebel', 'lando-calrissian', SYS);
  M.captureLeader(G, 'lando-calrissian', 'captured', { deferAutoRescue: true });
  // A 0-intel Empire leader at the target forces an OPPOSED roll (so the Rebel
  // actually rolls dice → a blank can trigger the Yoda offer) while rolling 0
  // opposition dice, so Luke reliably wins and the rescue effect fires.
  if (!G.empire.leaderPool.includes('general-veers') && !Object.values(G.empire.leadersOnBoard).some(a => a.includes('general-veers'))) {
    G.empire.leaderPool.push('general-veers');
  }
  M.placeLeader(G, 'Empire', 'general-veers', SYS);
  // Son of Skywalker in hand + a pullable rescue mission in the deck → the
  // post-success ring trigger that bobbi hit.
  if (!G.rebel.actionHand.includes('son-of-skywalker')) G.rebel.actionHand.push('son-of-skywalker');
  if (!G.rebel.missionDeck.includes('seek-yoda')) G.rebel.missionDeck.push('seek-yoda');
  // Assign FGG to Luke Jedi.
  G.rebel.leadersOnMissions.push({ missionId: 'for-the-greater-good', leaderIds: ['luke-skywalker-jedi'] });
  return G;
}

// Find a seed whose Rebel intel roll yields a blank (→ Yoda offer).
let G, found = false;
for (let s = 1; s < 400 && !found; s++) {
  G = setup(s);
  const r = phases.revealMission(G, 'Rebel', 'for-the-greater-good', SYS);
  if (!r.ok) continue;
  // Empire opposes with general-veers (0 intel → 0 opposition dice).
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null);
  if (G.pendingChoice?.kind === 'YodaReroll' && G.pendingChoice.context === 'mission') { found = true; break; }
}

console.log('[ #473: FGG + Luke Jedi + Yoda ring — decline the reroll ]');
check('reached the Yoda mission-reroll offer', found, 'no blank die found in 400 seeds');
if (found) {
  const capturedBefore = (G.empire.capturedLeaders ?? []).map(c => c.leaderId);
  check('Lando is captured before resolving', capturedBefore.includes('lando-calrissian'), JSON.stringify(capturedBefore));

  // DECLINE the Yoda reroll.
  const dr = phases.resolveYodaMissionReroll(G, null);
  check('decline resolved ok', dr.ok, dr.reason);

  // The exact state bobbi is stuck in RIGHT AFTER declining Yoda: a follow-up
  // offer is pending AND a mission report is queued in front of it. In the UI,
  // the offer modal is gated behind `missionReports.length === 0`, so the report
  // must be dismissible to reach the offer.
  console.log(`    [state after Yoda decline] pendingMission=${G.pendingMission?.stage} pendingChoice=${G.pendingChoice?.kind} missionReports=${G.missionReports?.length ?? 0} landoCaptured=${(G.empire.capturedLeaders ?? []).some(c => c.leaderId === 'lando-calrissian')}`);

  // Drive any legitimate follow-up offer to completion (this is what the human
  // does via modals). Son of Skywalker offer: decline it.
  let guard = 0;
  while (G.pendingChoice && guard++ < 10) {
    const k = G.pendingChoice.kind;
    if (k === 'SonOfSkywalkerOffer') { phases.resolveSonOfSkywalkerOffer(G, null); continue; }
    if (k === 'R2D2Flip' && G.pendingChoice.context === 'mission') { phases.resolveR2D2MissionFlip(G, null); continue; }
    if (k === 'OneInAMillionOffer' && G.pendingChoice.context === 'mission') { phases.resolveOneInAMillionMission(G, []); continue; }
    break;
  }

  // After the human answers the offer(s), the mission MUST be fully resolved.
  check('pendingMission cleared (no soft-lock)', !G.pendingMission, `stage=${G.pendingMission?.stage}`);
  check('no leftover pendingChoice we cannot resolve', !G.pendingChoice, `kind=${G.pendingChoice?.kind}`);
  const capturedAfter = (G.empire.capturedLeaders ?? []).map(c => c.leaderId);
  check('Lando was RESCUED (no longer captured)', !capturedAfter.includes('lando-calrissian'), JSON.stringify(capturedAfter));

  // The real bug surfaces as: a follow-up choice is posted while a mission report
  // is queued, so report gating hides it. Confirm the offer wasn't left dangling
  // behind a report.
  check('canEncode (no pending mission/choice/combat)', canEncode(G),
    `pm=${!!G.pendingMission} pc=${G.pendingChoice?.kind} reports=${G.missionReports?.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

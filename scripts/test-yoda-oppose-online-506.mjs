// #506 (bobbi, BGG) — "While opposing an Empire mission online as Rebel, the
// Yoda-ring dice-reroll prompt appears, then the game freezes: it says it's the
// opponent's turn and I have to wait."
//
// Every piece checks out in isolation — the engine posts the offer for the
// OPPOSER, choiceOwner tags it Rebel, currentActor resolves to the choice owner,
// and resolveYodaMissionReroll is wired into the adapter. So this drives the
// whole ONLINE round trip instead: reach the offer, redact the state for each
// seat the way the server does, and submit the answer through the adapter as
// the Rebel — the path a real online game actually takes.
//
// Note the original harness (scripts/test-yoda-oppose-freeze.mjs) never reached
// the offer at all: it set the target system NEUTRAL, but Gather Intel is
// "attempt in any REBEL system", so every reveal was rejected as an illegal
// target and the test reported a false negative for weeks.
//
// Run: node scripts/test-yoda-oppose-online-506.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const codec = await import('../src/engine/codec.ts');
const { canEncode } = codec;
const { pendingChoiceOwner } = await import('../src/engine/choiceOwner.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const ai = await import('../src/play/randomAI.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const SYS = 'tatooine';
const MISSION = 'gather-intel'; // Empire, intel x1, "attempt in any Rebel system"
const LUKE = 'luke-skywalker-jedi';
const EMP = 'emperor-palpatine';

/** Board where the Empire runs Gather Intel at a Rebel system and the Rebel can
 *  oppose with the Yoda-ring holder — who is then placed at the target, which is
 *  what makes the reroll offer reachable for the OPPOSER. */
function build(seed) {
  const G = createGame(data, { seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  const ss = G.map.systems[SYS];
  ss.loyalty = 'rebel'; ss.subjugated = false; ss.units = [];
  for (const list of Object.values(G.empire.leadersOnBoard)) { const i = list.indexOf(EMP); if (i >= 0) list.splice(i, 1); }
  G.empire.leaderPool = G.empire.leaderPool.filter((l) => l !== EMP);
  G.empire.leadersOnMissions = [{ missionId: MISSION, leaderIds: [EMP] }];
  for (const list of Object.values(G.rebel.leadersOnBoard)) { const i = list.indexOf(LUKE); if (i >= 0) list.splice(i, 1); }
  G.rebel.leadersOnMissions = (G.rebel.leadersOnMissions ?? []).filter((m) => !m.leaderIds.includes(LUKE));
  if (!G.rebel.leaderPool.includes(LUKE)) G.rebel.leaderPool.push(LUKE);
  M.attachRing(G, LUKE, 'yoda');
  return G;
}

/** Drive to a pending mission-context YodaReroll owned by the Rebel opposer. */
function reachOffer() {
  for (let s = 1; s <= 200; s++) {
    const G = build(s);
    if (!phases.revealMission(G, 'Empire', MISSION, SYS).ok) continue;
    if (G.pendingChoice?.kind !== 'OpposeMission') continue;
    if (!phases.resolveOpposition(G, LUKE).ok) continue;
    if (G.pendingChoice?.kind === 'YodaReroll' && G.pendingChoice.context === 'mission') return { G, seed: s };
  }
  return null;
}

console.log('[ #506 — Yoda reroll while OPPOSING, driven through the online adapter ]');
const hit = reachOffer();
check('the engine offers the Yoda reroll to the OPPOSER', !!hit,
  'never reached the offer — check the target system is Rebel-loyal');

if (hit) {
  const { G } = hit;
  check('the Rebel owns the prompt (and the Empire does not)',
    pendingChoiceOwner(G, 'Rebel') === true && pendingChoiceOwner(G, 'Empire') === false);
  // THE ONLINE QUESTION: whose turn does the server think it is? G.currentPlayer
  // is still 'Empire' here — if currentActor followed that instead of the choice
  // owner, the Rebel's client would show exactly bobbi's "it's the opponent's
  // turn and I have to wait".
  check('currentPlayer is still the Empire (so this is the real trap)', G.currentPlayer === 'Empire');
  check('but the server hands the turn to the REBEL', rebellionAdapter.currentActor(G) === 'Rebel',
    `currentActor=${rebellionAdapter.currentActor(G)}`);
  check('and the Rebel is allowed to act', rebellionAdapter.canAct(G, 'Rebel') === true);
  check('while the Empire is not', rebellionAdapter.canAct(G, 'Empire') === false);

  // The seat view the Rebel's client actually receives must still contain the
  // prompt — redaction strips hidden info and could plausibly take it with it.
  const view = rebellionAdapter.viewFor(G, 'Rebel');
  check('the redacted Rebel view still carries the pending prompt',
    view.pendingChoice?.kind === 'YodaReroll', `view pc=${view.pendingChoice?.kind}`);
  check('the redacted Rebel view still resolves the turn to the Rebel',
    rebellionAdapter.currentActor(view) === 'Rebel');

  // canEncode() is deliberately false here — it means "at a turn boundary", and
  // a choice IS pending. Online uses encodeFull instead (src/adapter/codec.ts),
  // which keeps pendingMission/pendingCombat/pendingChoice so an async game can
  // sit mid-prompt for days. THIS is the round trip a real online game takes
  // between showing bobbi the prompt and receiving the answer, so the mission's
  // stashed dice must survive it or the answer can't be resolved.
  check('canEncode is false mid-prompt (expected — that is a turn-boundary check)', !canEncode(G));
  const catalog = G.catalog;
  const revived = codec.decode(codec.encodeFull(G), catalog);
  check('the prompt survives the online store/reload round trip',
    revived.pendingChoice?.kind === 'YodaReroll' && revived.pendingChoice.context === 'mission',
    `pc=${revived.pendingChoice?.kind}`);
  check('the in-flight mission survives it too',
    !!revived.pendingMission, 'pendingMission lost — the answer would have nothing to apply to');
  check('the stashed dice survive it (resolveYodaMissionReroll needs them)',
    !!revived.pendingMission?.r2d2Pending
      && Array.isArray(revived.pendingMission.r2d2Pending.oppFaces)
      && revived.pendingMission.r2d2Pending.oppFaces.length > 0,
    'r2d2Pending stash lost across encodeFull/decode');
  check('and the reloaded state still hands the turn to the Rebel',
    rebellionAdapter.currentActor(revived) === 'Rebel');

  // Submit the answer the way the server does — ON THE RELOADED STATE, both
  // branches: decline, and take the reroll on a real blank index.
  for (const [label, idx] of [['decline', null], ['take the reroll', G.pendingChoice.blankIndices[0]]]) {
    const start = codec.decode(codec.encodeFull(G), catalog);
    const r = rebellionAdapter.tryApplyAction(start, { kind: 'resolveYodaMissionReroll', rerollIndex: idx }, 'Rebel');
    check(`the Rebel's answer is accepted after reload (${label})`, r.ok, r.reason);
    if (r.ok) {
      const after = r.state;
      check(`  no orphaned mission left behind (${label})`,
        !after.pendingMission || after.pendingChoice != null,
        `pm stage=${after.pendingMission?.stage} pc=${after.pendingChoice?.kind}`);
      check(`  SOMEBODY can move next — the game is not frozen (${label})`,
        rebellionAdapter.currentActor(after) !== null,
        'currentActor is null with the game still running');
      check(`  the result re-encodes for the next save (${label})`,
        (() => { try { codec.decode(codec.encodeFull(after), catalog); return true; } catch { return false; } })(),
        'encodeFull/decode threw on the post-answer state');
    }
  }

  // Seat enforcement. The adapter's dispatch does NOT re-check the actor for
  // choice resolvers — the framework is expected to gate on canAct first — so
  // assert the gate itself rather than tryApplyAction, which deliberately
  // bypasses it.
  check('canAct refuses the Empire for the Rebel\'s prompt (the real seat gate)',
    rebellionAdapter.canAct(G, 'Empire') === false && rebellionAdapter.canAct(G, 'Rebel') === true);

  // THE ACTUAL FREEZE CANDIDATE. Everything above proves the Rebel can answer.
  // What bobbi describes next — "it says it's the opponent's turn and I have to
  // wait" — is the AI Empire never moving afterwards. Server-side that is
  // runServerAI (functions/_lib/gameServer.ts), which loops
  //   actor = currentActor(state); if (!ai.includes(actor)) break;
  //   did = stepOnce(state, actor); if (!did) break;
  // so ANY choice the AI's stepOnce can't answer stops the loop dead and the
  // game sits on the human's screen as the opponent's turn, forever. Mirror
  // that loop exactly and require it to make progress.
  const resumed = codec.decode(codec.encodeFull(G), catalog);
  const answered = rebellionAdapter.tryApplyAction(resumed, { kind: 'resolveYodaMissionReroll', rerollIndex: null }, 'Rebel');
  if (answered.ok) {
    const st = answered.state;
    const aiSides = ['Empire'];
    let advanced = false, steps = 0, stuckOn = null;
    for (let i = 0; i < 4000; i++) {
      if (st.isGameOver) break;
      const actor = rebellionAdapter.currentActor(st);
      if (!actor || !aiSides.includes(actor)) { stuckOn = actor ? `human turn (${actor})` : 'no actor'; break; }
      let did = false;
      try { did = ai.stepOnce(st, actor); } catch (e) { stuckOn = 'threw: ' + String(e).slice(0, 80); break; }
      if (!did) { stuckOn = `stepOnce returned false for ${actor} on ${st.pendingChoice?.kind ?? 'no choice'}`; break; }
      advanced = true; steps++;
    }
    console.log(`    AI advance after the answer: ${steps} steps, stopped on: ${stuckOn}`);
    check('the AI Empire actually moves after the Rebel answers (no frozen game)',
      advanced || rebellionAdapter.currentActor(st) === 'Rebel',
      `AI never advanced — ${stuckOn}`);
    check('and it does not stall on a choice it cannot answer',
      !/stepOnce returned false/.test(stuckOn ?? '') && !/threw/.test(stuckOn ?? ''),
      String(stuckOn));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

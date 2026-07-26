// #581/#617/#600 (+#574/#599/#629/#630/#639) — the passivity cluster. The AI
// kept passing its Command round while leaders sat on face-down missions.
//
// Root cause: the Assignment phase and the Command phase judged a mission by
// DIFFERENT rules, so assignment committed leaders to missions the Command
// phase then refused to reveal. Two mismatches:
//   1. Assignment mirrored the Command phase's "has a legal target" check but
//      not its missionRevealIsPointless filter (added later). The Empire kept
//      assigning Superlaser Online — 87 assignments to 6 reveals over 40 games.
//   2. Assignment scored a mission by base value only, while the Command phase
//      also adds the per-target score with its decisive penalties (-50 remote,
//      -30 already-loyal). Support of Mon Calamari scored 12 at assignment and
//      below the pass action at every legal target.
// Leaders stranded on unrevealable missions can't activate systems, so the side
// runs out of things to do and passes.
//
// Both phases now go through bestRevealTarget, so they cannot disagree. This is
// a tripwire: if the two ever drift apart again, stranding climbs and these
// assertions fail.
// Run: node scripts/test-assign-command-agree-581.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');
const { missionRevealIsPointless, missionTargets } = await import('../src/engine/missionTargets.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const GAMES = 12;
const EXP = { enabled: true, roteUnits: true, roteMissionsRebel: true, roteMissionsEmpire: true };

console.log('[ #581 — assignment must not commit leaders to missions Command won\'t reveal ]');
{
  // Walk self-play games. At every point a side is about to PASS, any mission
  // still assigned to it must have a REASON the Command phase can't play it that
  // assignment could not have foreseen (target vanished, skill shortfall). What
  // must NOT happen is a mission stranded because every target is pointless —
  // that is the mismatch this fix closes, and assignment can see it too.
  let strandedPointless = 0, strandedTotal = 0, passDecisions = 0;
  const assigned = new Map(), revealed = new Map();
  for (let seed = 1; seed <= GAMES; seed++) {
    ai.seedAI(seed);
    const G = createGame(data, { seed, autoSetupUnits: true, expansion: EXP });
    let guard = 0;
    while (!G.isGameOver && guard++ < 6000) {
      const side = G.currentPlayer;
      if (G.phase === 'Command' && !G.pendingChoice && !G.pendingMission && !G.pendingCombat) {
        let top = null;
        try { top = ai.bestCommandAction(G, side)[0]; } catch { /* ignore */ }
        if (top && top.kind === 'pass') {
          passDecisions++;
          const f = side === 'Rebel' ? G.rebel : G.empire;
          for (const am of f.leadersOnMissions) {
            strandedTotal++;
            const t = missionTargets(G, side, am.missionId);
            const cand = t.permissive ? Object.keys(G.map.systems) : t.systemIds;
            // Fresh-capture missions are deliberately assigned ahead of a live
            // target (the opponent's leaders surface during the Command phase),
            // so they are exempt from the pointless accounting.
            const FRESH = am.missionId === 'detained' || am.missionId === 'collect-bounty';
            if (!FRESH && cand.length > 0
                && cand.every((sid) => missionRevealIsPointless(G, side, am.missionId, sid))) {
              strandedPointless++;
            }
          }
        }
      }
      if (!ai.stepOnce(G, side)) {
        const o = side === 'Rebel' ? 'Empire' : 'Rebel';
        if (!ai.stepOnce(G, o)) break;
      }
    }
    for (const e of G.turnLog) {
      const m = e.payload?.missionId; if (!m) continue;
      if (e.kind === 'assign-leader') assigned.set(m, (assigned.get(m) ?? 0) + 1);
      if (e.kind === 'reveal-mission') revealed.set(m, (revealed.get(m) ?? 0) + 1);
    }
  }

  const perPass = strandedTotal / Math.max(1, passDecisions);
  console.log(`    ${passDecisions} pass decisions, ${strandedTotal} face-down missions at pass time` +
    ` (${perPass.toFixed(2)}/pass), ${strandedPointless} of them all-targets-pointless`);
  // Pre-fix this ran ~0.9 pointless-stranded per pass decision; the gate takes
  // it to ~0. Allow a small margin for boards that changed after assignment.
  check('few missions stranded because every target is pointless',
    strandedPointless / Math.max(1, passDecisions) < 0.15,
    `${strandedPointless} over ${passDecisions} pass decisions`);

  // Conversion: leaders committed to a mission should usually get to play it.
  // Pre-fix, the three worst offenders converted at 7% / 32% / 49%; after, at
  // 36% / 92% / 95%. The aggregate is the stable signal — per-mission rates go
  // noisy once the gate stops the AI assigning these dozens of times a game
  // (Superlaser Online drops from ~87 assignments per 40 games to ~11), so a
  // per-mission rate is only asserted with a big enough sample behind it.
  let aggA = 0, aggR = 0;
  for (const [m, a] of assigned) { aggA += a; aggR += revealed.get(m) ?? 0; }
  const aggRate = aggR / Math.max(1, aggA);
  check(`overall assigned→revealed conversion is high (${(100 * aggRate).toFixed(0)}% of ${aggA} assignments)`,
    aggRate >= 0.8, `only ${(100 * aggRate).toFixed(0)}% of assigned missions were revealed`);

  const MIN_SAMPLE = 10;
  for (const m of ['superlaser-online', 'support-of-mon-calamari', 'wookie-uprising']) {
    const a = assigned.get(m) ?? 0;
    if (a < MIN_SAMPLE) {
      // Not a failure — the gate reducing these to a handful is the POINT.
      console.log(`    (skipped ${m}: only ${a} assignments, below the ${MIN_SAMPLE}-sample bar)`);
      continue;
    }
    const c = (revealed.get(m) ?? 0) / a;
    check(`${m} reveal-rate is healthy (${(100 * c).toFixed(0)}% of ${a} assignments)`,
      c >= 0.5, `only ${(100 * c).toFixed(0)}% revealed`);
  }

  // GUARD the deliberate exception: fresh-capture missions target enemy leaders
  // that are still in the pool at assignment time, so they MUST still be
  // assignable despite having no board target yet (they were restored once
  // already — the Empire captured 0 leaders per game when this broke).
  const fresh = (assigned.get('detained') ?? 0) + (assigned.get('collect-bounty') ?? 0);
  check('fresh-capture missions (Detained / Collect Bounty) are still assigned',
    fresh > 0, 'the gate swallowed the fresh-capture exception');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

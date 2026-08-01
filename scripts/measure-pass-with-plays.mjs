// measure-pass-with-plays.mjs — INSTRUMENTATION, not a pass/fail gate.
//
// Seven reports say the AI quits its Command phase with resources unspent:
//   #617 "passed very early despite two leaders in pool and five facedown missions"
//   #629 "passed with a leader left in the pool and fleets that can still be moved"
//   #581 "passed with 4 leaders on missions"
//   #649 "passed while having vader on a facedown mission"
//   #600 "the REBEL player passed with 3 facedown missions and some leaders in pool"
//   #580 "several fleets with great targets next to them yet he passes"
//
// A pass is only a bug if something was actually available, so this counts passes
// that left leaders in the pool or missions unresolved, and — the part that decides
// where the fix goes — splits them by WHY, using the ai-decision trace the heuristic
// already writes for every Command decision:
//
//   NO-ALTS    nothing was generated at all      -> action GENERATION gap
//   LOW-SCORE  generated, but all scored <= 0.5  -> SCORING gap (PASS_ACTION_SCORE)
//   REJECTED   scored above pass, engine refused -> LEGALITY / executor gap
//
// Run: node scripts/measure-pass-with-plays.mjs [--games 30]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const ai = await import('../src/play/randomAI.ts');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const GAMES = arg('--games', 30);
const MAX_STEPS = 20000;
const PASS_SCORE = 0.5;

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json') };

const fac = (G, side) => (side === 'Rebel' ? G.rebel : G.empire);

const tally = {
  Rebel:  { passes: 0, withPlays: 0, noAlts: 0, lowScore: 0, rejected: 0, pool: 0, facedown: 0, naPool: 0, naFace: 0, naBoth: 0 },
  Empire: { passes: 0, withPlays: 0, noAlts: 0, lowScore: 0, rejected: 0, pool: 0, facedown: 0, naPool: 0, naFace: 0, naBoth: 0 },
};
const samples = [];

for (let g = 0; g < GAMES; g++) {
  let G;
  try { G = createGame(data, { seed: g + 1, autoSetupUnits: true }); } catch { continue; }

  for (let s = 0; s < MAX_STEPS; s++) {
    if (G.isGameOver) break;
    const actor = rebellionAdapter.currentActor(G);
    if (!actor) break;

    // Snapshot what the side still had, BEFORE it decided.
    const f = fac(G, actor);
    const pool = (f.leaderPool ?? []).length;
    const facedown = (f.leadersOnMissions ?? []).length;
    const logLen = (G.turnLog ?? []).length;

    let did = false;
    try { did = ai.stepOnce(G, actor); } catch { break; }
    if (!did) break;

    // Any ai-decision appended by that step.
    for (const e of (G.turnLog ?? []).slice(logLen)) {
      if (e?.kind !== 'ai-decision') continue;
      const p = e.payload ?? {};
      if (p.chose?.kind !== 'pass') continue;
      const t = tally[e.side] ?? tally[actor];
      t.passes++;
      if (pool === 0 && facedown === 0) continue; // nothing left — a legitimate pass
      t.withPlays++;
      t.pool += pool; t.facedown += facedown;
      const alts = (p.alts ?? []).filter((a) => a.kind !== 'pass');
      const best = alts.length ? Math.max(...alts.map((a) => a.score ?? 0)) : null;
      if (!alts.length) {
        t.noAlts++;
        if (pool > 0 && facedown > 0) t.naBoth++; else if (pool > 0) t.naPool++; else t.naFace++;
      }
      else if ((p.rejected ?? 0) > 0 && best > PASS_SCORE) t.rejected++;
      else if (best <= PASS_SCORE) t.lowScore++;
      else t.rejected++;
      if (samples.length < 6) {
        samples.push(`    ${e.side} pool=${pool} facedown=${facedown} rejected=${p.rejected ?? 0} bestAlt=${best === null ? 'none' : best} alts=${JSON.stringify(alts.slice(0, 3))}`);
      }
    }
  }
}

console.log(`\n=== Command passes with resources still unspent, ${GAMES} self-play games ===`);
for (const side of ['Rebel', 'Empire']) {
  const t = tally[side];
  const pctv = t.passes ? Math.round((t.withPlays / t.passes) * 100) : 0;
  console.log(`\n  ${side}: ${t.passes} passes, ${t.withPlays} with something still available (${pctv}%)`);
  if (t.withPlays) {
    console.log(`    left unspent: ${t.pool} leaders in pool, ${t.facedown} missions facedown (totals)`);
    console.log(`    NO-ALTS   (nothing generated)      ${t.noAlts}   [leaders-in-pool only: ${t.naPool}, facedown-only: ${t.naFace}, both: ${t.naBoth}]`);
    console.log(`    LOW-SCORE (all scored <= ${PASS_SCORE})     ${t.lowScore}`);
    console.log(`    REJECTED  (engine refused better)  ${t.rejected}`);
  }
}
if (samples.length) { console.log('\n  samples:'); for (const s of samples) console.log(s); }
console.log();

// RandomAI-vs-RandomAI rollout test for the GameAdapter, per the
// adapter-spec.md invariant suite. Exercises:
//
//   - currentActor never disagrees with legalActions ([] iff no actor)
//   - legalActions is non-empty whenever there's a current actor
//   - applyAction never throws on a legal action
//   - games terminate (result() != null within step cap)
//
// Run: node scripts/test-adapter-rollout.mjs --trials 50 --seed 1
// Exits non-zero on any divergence.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = (() => {
  const a = process.argv.slice(2);
  const out = { trials: 20, seed: 1, stepCap: 50000, verbose: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--trials') out.trials = parseInt(a[++i], 10);
    else if (a[i] === '--seed') out.seed = parseInt(a[++i], 10);
    else if (a[i] === '--step-cap') out.stepCap = parseInt(a[++i], 10);
    else if (a[i] === '--verbose' || a[i] === '-v') out.verbose = true;
  }
  return out;
})();

// Register tsx for .ts imports.
{
  const mod = await import('tsx/esm/api');
  mod.register();
}

const { createGame } = await import('../src/engine/setup.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems:    loadJson('systems.json'),
  adjacency:  loadJson('adjacency.json'),
  leaders:    loadJson('leaders.json'),
  actions:    loadJson('actions.json'),
  missions:   loadJson('missions.json'),
  objectives: loadJson('objectives.json'),
  tactics:    loadJson('tactics.json'),
  probes:     loadJson('probes.json'),
};

// Tiny mulberry32 for deterministic action pick within a trial.
function mkRng(seed) {
  let s = seed | 0; if (s === 0) s = 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const failures = [];
const completed = { wins: { Rebel: 0, Empire: 0, draw: 0 }, stuck: 0, threw: 0, emptyLegal: 0 };

for (let trial = 0; trial < args.trials; trial++) {
  const seed = args.seed * 1000 + trial;
  const rng = mkRng(seed + 17);
  let G;
  try { G = createGame(data, { seed }); }
  catch (e) { failures.push({ trial, seed, where: 'createGame', err: String(e) }); continue; }

  let steps = 0;
  let trialFailed = false;
  let lastAction = null;
  let lastActor = null;
  while (!trialFailed && steps < args.stepCap) {
    const actor = rebellionAdapter.currentActor(G);
    if (actor === null) break; // game over
    let legal;
    try { legal = rebellionAdapter.legalActions(G, actor); }
    catch (e) {
      failures.push({ trial, seed, steps, where: 'legalActions', actor, err: String(e), lastAction });
      trialFailed = true; break;
    }
    if (!legal || legal.length === 0) {
      completed.emptyLegal++;
      failures.push({
        trial, seed, steps, where: 'legalActions-empty', actor,
        phase: G.phase, pendingChoice: G.pendingChoice?.kind ?? null, lastAction, lastActor,
      });
      trialFailed = true; break;
    }
    const action = legal[Math.floor(rng() * legal.length)];
    try { G = rebellionAdapter.applyAction(G, action, actor); }
    catch (e) {
      completed.threw++;
      failures.push({
        trial, seed, steps, where: 'applyAction-threw', actor,
        action, phase: G.phase, pendingChoice: G.pendingChoice?.kind ?? null, err: String(e),
      });
      trialFailed = true; break;
    }
    lastAction = action; lastActor = actor;
    steps++;
  }

  if (!trialFailed) {
    const r = rebellionAdapter.result(G);
    if (r) {
      if (r.winners.length === 0) completed.wins.draw++;
      else completed.wins[r.winners[0]]++;
    } else {
      completed.stuck++;
      failures.push({
        trial, seed, steps, where: 'step-cap',
        phase: G.phase, pendingChoice: G.pendingChoice?.kind ?? null,
      });
    }
  }
  if (args.verbose) {
    process.stdout.write(`  trial ${trial+1}/${args.trials} seed=${seed} steps=${steps} ${trialFailed ? 'FAIL' : 'ok'}\n`);
  }
}

console.log('');
console.log(`Trials:            ${args.trials}`);
console.log(`Rebel wins:        ${completed.wins.Rebel}`);
console.log(`Empire wins:       ${completed.wins.Empire}`);
console.log(`Draws:             ${completed.wins.draw}`);
console.log(`Stuck (step-cap):  ${completed.stuck}`);
console.log(`legalActions=[]:   ${completed.emptyLegal}`);
console.log(`applyAction threw: ${completed.threw}`);
console.log(`Failures:          ${failures.length}`);

if (failures.length > 0) {
  console.log('');
  console.log('--- First 5 failures ---');
  for (const f of failures.slice(0, 5)) {
    console.log(JSON.stringify(f, null, 2));
  }
  process.exit(1);
}
console.log('All trials passed.');

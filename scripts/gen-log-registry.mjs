// Generates docs/log-events.md — the turnLog event registry (log-format v2).
//
// - Extracts every event `kind` the source can emit (log/logEvent/logForSide/
//   logState call sites across src/engine + src/play).
// - Mines a real sample payload for each kind from the logs/ corpus, falling
//   back to a fresh seeded self-play game (covers brand-new kinds the corpus
//   hasn't seen yet).
// - PRESERVES the hand-written Description column across regenerations: it
//   re-reads the current docs/log-events.md and carries descriptions forward,
//   so regenerating after adding a kind never loses editorial work.
//
// Run: node scripts/gen-log-registry.mjs
// Guarded by: scripts/test-log-registry.mjs (fails CI-style when a source kind
// is missing from the doc — regenerate + describe to fix).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGameLog } from './lib/log-reader.mjs';
import { extractKindsFromSource } from './lib/log-kinds.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(ROOT, 'docs', 'log-events.md');

/** Mine one sample payload per kind from the newest ~80 corpus logs. */
function mineSamples() {
  const samples = new Map();
  const dir = join(ROOT, 'logs');
  if (!existsSync(dir)) return samples;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).slice(-80);
  for (const f of files) {
    let L;
    try { L = readGameLog(join(dir, f)); } catch { continue; }
    for (const e of L.events) {
      if (!samples.has(e.kind) && e.payload !== undefined) samples.set(e.kind, e.payload);
    }
  }
  return samples;
}

/** Fresh seeded self-play game for kinds the corpus hasn't seen (e.g. a kind
 *  added this session). */
async function mineFreshGameSamples(into) {
  const { register } = await import('tsx/esm/api'); register();
  const { createGame } = await import('../src/engine/setup.ts');
  const phases = await import('../src/engine/phases.ts');
  const { stepOnce, seedAI } = await import('../src/play/randomAI.ts');
  const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
  const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
  seedAI(3); const G = createGame(data, { seed: 3, autoSetupUnits: false });
  let n = 0; while (G.phase === 'Setup' && n++ < 100) { if (!stepOnce(G, G.currentPlayer)) { const o = G.currentPlayer === 'Rebel' ? 'Empire' : 'Rebel'; if (!stepOnce(G, o)) { phases.setupAutoFill(G, 'Rebel'); phases.setupAutoFill(G, 'Empire'); } } }
  let st = 0; while (!G.isGameOver && st < 200000) { const sd = G.currentPlayer; if (stepOnce(G, sd)) { st++; continue; } const o = sd === 'Rebel' ? 'Empire' : 'Rebel'; if (stepOnce(G, o)) { st++; continue; } break; }
  for (const e of G.turnLog) {
    if (e.kind === 'state') {
      // Don't inline a whole board — describe the shape instead.
      if (!into.has('state')) into.set('state', { codec: '(full board snapshot, JSON codec string)', at: e.payload?.at });
      continue;
    }
    if (!into.has(e.kind) && e.payload !== undefined) into.set(e.kind, e.payload);
  }
}

/** Carry forward hand-written descriptions from the existing doc. */
function existingDescriptions() {
  const out = new Map();
  if (!existsSync(DOC)) return out;
  const txt = readFileSync(DOC, 'utf8');
  for (const m of txt.matchAll(/^\| `([a-z0-9-]+)` \| ([^|]*) \|/gm)) {
    const desc = m[2].trim();
    if (desc && desc !== '—') out.set(m[1], desc);
  }
  return out;
}

// Seed descriptions for the structurally-important kinds (first generation
// only — after that, edit the doc and regeneration preserves your text).
const SEED_DESC = new Map(Object.entries({
  'state': 'Full board snapshot (codec string, turnLog-stripped). `at` says why: setup-complete / turn-start / base-reveal / base-assault.',
  'ai-decision': 'AI Command decision trace: chosen action + score, top-5 alternatives, engine-rejected count, planner state when enabled.',
  'setup': 'Game seed + starting loyalty draw. The seed here is meta.seed in v2.',
  'setup-deploy': 'One manually-placed setup unit (unit id included). Auto-filled units are NOT evented — read the setup-complete snapshot.',
  'advance-time': 'Time marker advanced (start of a new turn; followed by the turn-start snapshot).',
  'reveal-base': 'Rebel base revealed (followed by the base-reveal snapshot).',
  'activate-system': 'Leader activates a system; orders = source systems, unitsMoved = total units.',
  'move-unit': 'One unit moved (self-contained: id + typeId + from/to).',
  'deploy': 'One built unit deployed to a system (id + typeId).',
  'destroy-unit': 'One unit destroyed (id + typeId + where + cause).',
  'combat-begin': 'Combat starts. A base assault also writes the base-assault snapshot.',
  'combat-end': 'Combat over (rounds fought, winner).',
  'combat-attack': 'One attack roll (theater, dice faces, attacker count).',
  'combat-retreat': 'Retreat executed (from/to, units, leader).',
  'reveal-mission': 'Mission revealed at a target system.',
  'mission-roll': 'Contested mission dice resolution.',
  'mission-unopposed': 'Mission auto-succeeded unopposed.',
  'subjugated': 'System subjugated (Empire).',
  'liberated': 'Subjugation removed.',
  'gain-loyalty': 'Loyalty gained at a system.',
  'gain-reputation': 'Rebel reputation advanced.',
  'capture-leader': 'Leader captured (ring: captured/carbonite).',
  'pick-rebel-base': 'Rebel base location chosen at setup.',
  'rapid-mobilization-base-established': 'Base relocated via Rapid Mobilization.',
  'rapid-mobilization-old-base-probe-to-empire': 'Old base probe card given to the Empire after relocation (LTP p.12).',
  'build-queue': 'Unit added to the build queue.',
  'recruit-leader': 'Leader recruited.',
  'phase': 'Phase transition marker.',
  'pass': 'Command turn passed.',
  'game-over': 'Terminal event: winner + reason.',
}));

const kinds = extractKindsFromSource();
const samples = mineSamples();
await mineFreshGameSamples(samples);
const prevDesc = existingDescriptions();

const rows = [...kinds.keys()].sort().map((kind) => {
  const desc = prevDesc.get(kind) ?? SEED_DESC.get(kind) ?? '—';
  const sample = samples.has(kind)
    ? JSON.stringify(samples.get(kind)).slice(0, 110).replace(/\|/g, '\\|')
    : '(not seen in corpus or sample game)';
  const files = [...kinds.get(kind)].sort().join(', ');
  return `| \`${kind}\` | ${desc} | \`${sample}\` | ${files} |`;
});

const doc = `# turnLog event registry (log-format v2)

> AUTO-GENERATED TABLE — regenerate with \`node scripts/gen-log-registry.mjs\`.
> Descriptions are hand-editable: regeneration preserves them. The tripwire
> \`node scripts/test-log-registry.mjs\` fails when a source kind is missing
> here, so a new event can't ship undocumented.

## The envelope

Every turnLog entry (see \`log()\` in \`src/engine/log.ts\`):

\`\`\`ts
{
  seq: number,      // monotonic append index — ordering + cross-reference key
  turn: number,     // G.timeMarker at write time
  phase: string,    // Setup | Assignment | Command | Refresh | GameOver
  side?: 'Rebel' | 'Empire',   // the acting side, when the event has one
  kind: string,     // one of the kinds below
  payload?: object, // kind-specific data (sampled below)
}
\`\`\`

Entries written before 2026-07-10 lack \`seq\`/\`phase\` (and snapshots lack the
\`at\` label) — readers default missing labels to \`turn-start\`.

## The containers

- **v2** (current uploads): \`{ schemaVersion: 2, gameId, meta, timeline,
  keyframes, final }\` — built by \`src/play/logFormat.ts\` at upload time.
  \`meta\` carries seed, expansion, human/AI sides, AI policy + planner flag,
  build SHA, and outcome. \`timeline[t]\` = board snapshot at the start of turn
  t + that turn's events. \`keyframes\` = base-reveal / base-assault boards.
  \`final\` = end board, turnLog-stripped.
- **v1** (the 558 logs before 2026-07-10): \`{ schemaVersion: 1, hash, game }\`
  with the full history nested inside \`game.codec\` (a JSON string).

**Always read logs through \`scripts/lib/log-reader.mjs\`** — it normalizes both
formats to \`{ meta, humanSide, winner, events, snapshots, final }\`.

## Adding a new event kind

1. Emit it via \`log()\`/\`logForSide()\` with a **self-contained** payload —
   any unit reference carries \`unit\` (instance id) **and** \`typeId\`; any
   system reference uses the system id.
2. Run \`node scripts/gen-log-registry.mjs\`, then edit your kind's Description.
3. \`node scripts/test-log-registry.mjs\` must pass.

## Kinds (${rows.length})

| Kind | Description | Sample payload | Emitted from |
|---|---|---|---|
${rows.join('\n')}
`;

writeFileSync(DOC, doc);
console.log(`Wrote ${DOC}: ${rows.length} kinds (${[...kinds.keys()].filter((k) => !samples.has(k)).length} without samples).`);

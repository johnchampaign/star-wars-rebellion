// #827 — "Minor Skills are not noted under Leader Info dropdowns for each leader,
// just Major Skills." #828 — "No way to see rings on leaders."
//
// The leader roster printed major skills only, and rings were listed in a single
// row of the Rebel panel, so neither could be read off the leader. The roster,
// map tokens and assignment pickers now read both from src/play/leaderInfo.ts.
// These pin what those helpers report: the same minor count the mission roll
// uses (expansion-gated, K-2SO's ring-granted icons included), and every ring
// kind the engine can attach has a name and an effect.
//
// Run: node scripts/test-leader-rings-minors-827-828.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const info = await import('../src/play/leaderInfo.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };
const minors = (G, id) => Object.fromEntries(info.leaderMinorSkills(G, id).map((m) => [m.key, m.value]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const G = createGame(data, { seed: 1 });
G.expansion = { ...(G.expansion ?? {}), enabled: true };
console.log('#827 minor skills');
check('Jyn Erso shows her printed minors', same(minors(G, 'jyn-erso'), { D: 1, I: 2, O: 1 }), JSON.stringify(minors(G, 'jyn-erso')));
check('a leader with no minors shows none', info.leaderMinorSkills(G, 'mon-mothma').length === 0);

G.leaderAttachments = { 'mon-mothma': ['k2so'] };
check('K-2SO ring adds its minor Intel + Spec-Ops', same(minors(G, 'mon-mothma'), { I: 1, O: 1 }), JSON.stringify(minors(G, 'mon-mothma')));

const base = createGame(data, { seed: 1 });
base.expansion = { ...(base.expansion ?? {}), enabled: false };
base.leaderAttachments = { 'mon-mothma': ['k2so'] };
check('base game shows no minors (they would not roll)',
  info.leaderMinorSkills(base, 'jyn-erso').length === 0 && info.leaderMinorSkills(base, 'mon-mothma').length === 0);

console.log('#828 rings');
G.leaderAttachments = { 'mon-mothma': ['r2d2'] };
check('the ring is named on its leader', same(info.leaderRingLabels(G, 'mon-mothma'), ['R2-D2']));
check('a leader without a ring has none', info.leaderRingLabels(G, 'jan-dodonna').length === 0);
check('the tooltip says what it does', /R2-D2 — discard to turn 1/.test(info.leaderRingTooltip(G, 'mon-mothma')), info.leaderRingTooltip(G, 'mon-mothma'));

// Every kind the engine can attach, read from its own type so a new ring can't ship unnamed.
const mech = readFileSync(join(ROOT, 'src/engine/mechanics.ts'), 'utf-8');
const kinds = [...mech.match(/export type AttachmentKind = ([^;]+);/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('found the ring kinds', kinds.length >= 7, kinds.join());
for (const k of kinds) {
  G.leaderAttachments = { 'mon-mothma': [k] };
  const tip = info.leaderRingTooltip(G, 'mon-mothma');
  check(`${k} has a name and an effect`, !!info.RING_LABELS[k] && !tip.endsWith('— ') && !tip.includes('undefined'), tip);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

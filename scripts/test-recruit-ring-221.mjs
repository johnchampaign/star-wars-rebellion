// #221 — recruiting a droid-ring card offers the ring immediately.
// Run: node scripts/test-recruit-ring-221.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const G = createGame(data, { seed: 7, roeUnits: true, roeMissions: true });
check('he-means-well in catalog', !!G.catalog.actions['he-means-well']);
check('cassian recruitable', phases.leaderRecruitable(G, 'Rebel', 'cassian-andor'));

// Skip Assignment + Command so the round rolls into Refresh (time -> 2 = recruit).
phases.skipAssignment(G, 'Rebel'); phases.skipAssignment(G, 'Empire');
// Stack the Rebel deck so the recruit draw pulls He Means Well first.
G.rebel.actionDeck = ['he-means-well', 'our-most-desperate-hour', ...G.rebel.actionDeck.filter((c) => c !== 'he-means-well')];
phases.pass(G, 'Rebel'); phases.pass(G, 'Empire');

check('time advanced to recruit turn', G.timeMarker === 2, `timeMarker=${G.timeMarker}`);
let c = G.pendingChoice;
check('Rebel recruit pick posted with He Means Well', c?.kind === 'RecruitActionCardPick' && c.side === 'Rebel' && c.drawnIds.includes('he-means-well'), `got ${c?.kind} ${JSON.stringify(c?.drawnIds)}`);

const r1 = phases.resolveRecruitActionCardPick(G, 'he-means-well');
check('recruit resolve ok', r1.ok, r1.reason);
check('cassian now in pool', G.rebel.leaderPool.includes('cassian-andor'));

c = G.pendingChoice;
check('ring offered immediately (AttachRingPick, viaRecruit)',
  c?.kind === 'AttachRingPick' && c.cardId === 'he-means-well' && c.ringId === 'k2so' && c.viaRecruit === true,
  `got ${c?.kind} via=${c?.viaRecruit}`);

const target = c?.candidates?.includes('cassian-andor') ? 'cassian-andor' : c?.candidates?.[0];
const r2 = phases.resolveAttachRing(G, target);
check('attach resolve ok', r2.ok, r2.reason);
const attached = (G.leaderAttachments?.[target] ?? []).includes('k2so');
check(`k2so ring attached to ${target}`, attached, JSON.stringify(G.leaderAttachments));
check('He Means Well left the hand (now in-play as a ring)', !G.rebel.actionHand.includes('he-means-well'));
check('recruit flow resumed (no longer stuck on the ring pick)', G.pendingChoice?.kind !== 'AttachRingPick');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

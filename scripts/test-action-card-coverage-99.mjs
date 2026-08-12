// Audit #99 — every action card has a wired play path. This is a TRIPWIRE: it
// pins the audited set of action cards (by timing → handling path) so that
// adding a new card to assets/actions.json without wiring it — or removing one
// without updating the code — fails loudly here.
//
// Wiring paths (verified in this audit):
//   Assignment    → applyAssignmentActionCardEffect switch (phases.ts)
//   StartOfCombat → applyStartOfCombatActionCardEffect switch (combat.ts)
//   Immediate     → applyImmediateActionCardEffect switch, OR a droid ring
//                   (DROID_RING_CARDS), OR a passive from-hand trigger (Falcon)
//   Special       → a typed *Offer pendingChoice posted from a mission/combat hook
// Run: node scripts/test-action-card-coverage-99.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const actions = JSON.parse(readFileSync(join(ROOT, 'assets', 'actions.json'), 'utf-8'));
// Flatten to the leaf card objects (id + side + timing).
const cards = [];
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (o && typeof o === 'object') {
    if (o.id && o.side && (o.timing || o.rulesText)) cards.push(o);
    Object.values(o).forEach(walk);
  }
})(actions);

// The audited wiring map: every action card → the path that handles it.
const WIRED = {
  // ---- Assignment (applyAssignmentActionCardEffect) ----
  'ambush': 'assignment', 'an-old-friend': 'assignment', 'false-orders': 'assignment',
  'independent-operation': 'assignment', 'our-most-desperate-hour': 'assignment',
  'rebel-planning': 'assignment', 'start-the-evacuation': 'assignment',
  'temporary-alliance': 'assignment', 'trust-in-the-force': 'assignment',
  'boba-fett-where': 'assignment', 'brilliant-administrator': 'assignment',
  'catch-them-by-surprise': 'assignment', 'local-rumors': 'assignment',
  'proceeding-as-planned': 'assignment',
  'public-support': 'assignment', 'scouting-mission': 'assignment',
  // ---- StartOfCombat (applyStartOfCombatActionCardEffect) ----
  'according-to-my-design': 'startofcombat', 'fully-operational': 'startofcombat',
  'good-intel': 'startofcombat', 'keep-them-from-escaping': 'startofcombat',
  'more-dangerous-than-you-realize': 'startofcombat', 'ready-for-action': 'startofcombat',
  'target-the-generator': 'startofcombat', 'baze-s-loyalty': 'startofcombat',
  'its-a-trap': 'startofcombat', 'point-blank-assault': 'startofcombat',
  'target-the-star-destroyers': 'startofcombat',
  // ---- Immediate (switch, droid ring, or passive) ----
  'early-promotion': 'immediate', 'secret-facility': 'immediate', 'sweep-the-area': 'immediate',
  'rebel-extremist': 'immediate', 'under-the-radar': 'immediate',
  'lord-vader-s-orders': 'immediate',
  'resourceful-astromech': 'droid-ring', 'human-cyborg-relations': 'droid-ring',
  'he-means-well': 'droid-ring', 'the-milleninium-falcon': 'passive-trigger',
  // ---- Special (typed *Offer trigger) ----
  'ambitions-of-power': 'special-offer', 'blindside': 'special-offer',
  'it-is-your-destiny': 'special-offer', 'post-bounty': 'special-offer',
  'track-them': 'special-offer', 'noble-sacrifice': 'special-offer',
  'one-in-a-million': 'special-offer', 'something-to-fight-for': 'special-offer',
  'son-of-skywalker': 'special-offer', 'undercover': 'special-offer',
  'wookie-guardian': 'special-offer',
};

console.log('\n[ #99 every action card maps to a wired play path ]');
const catalogIds = cards.map((c) => c.id);
const unwired = catalogIds.filter((id) => !WIRED[id]);
check('no action card is missing a wired play path',
  unwired.length === 0,
  `unwired: ${unwired.join(', ')} (add a play path + list it in this test)`);

const stale = Object.keys(WIRED).filter((id) => !catalogIds.includes(id));
check('no stale entries (every wired id still exists in the catalog)',
  stale.length === 0, `stale: ${stale.join(', ')}`);

check('all 48 action cards accounted for', catalogIds.length === 48, `got ${catalogIds.length}`);

// Sanity: a card's timing should match its handling bucket where applicable.
const timingMismatch = cards.filter((c) => {
  const p = WIRED[c.id];
  if (p === 'assignment') return c.timing !== 'Assignment';
  if (p === 'startofcombat') return c.timing !== 'StartOfCombat';
  if (p === 'special-offer') return c.timing !== 'Special';
  // immediate / droid-ring / passive are all Immediate-timed
  if (['immediate', 'droid-ring', 'passive-trigger'].includes(p)) return c.timing !== 'Immediate';
  return false;
});
check('card timing matches its handling path',
  timingMismatch.length === 0,
  `mismatched: ${timingMismatch.map((c) => `${c.id}(${c.timing})`).join(', ')}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

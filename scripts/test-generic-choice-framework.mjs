// Generic choice framework (#424/#462 The Long War + the framework itself).
// Verifies: resolveGenericChoice validation (membership / min / max / no-resolver),
// The Long War raises a card-domain choice and discards exactly the chosen 2,
// the exactly-2 fast path, and the Plan The Assault revealed-base source
// contract the modal/AI depend on.
// Run: node scripts/test-generic-choice-framework.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const choices = await import('../src/engine/choices.ts');
const handlers = await import('../src/engine/handlers/registry.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true } });

// ---------------------------------------------------------------------------
console.log('resolveGenericChoice validation:');
{
  const G = createGame(data, opts(1));
  let ran = null;
  choices.registerChoice('__test_tag', (g, selection) => { ran = selection; });
  const raise = () => choices.requestChoice(G, {
    tag: '__test_tag', side: 'Rebel', domain: 'option',
    prompt: 'pick', candidates: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    min: 1, max: 2,
  });

  raise();
  check('rejects a non-candidate id', !phases.resolveGenericChoice(G, ['z']).ok);
  check('rejects too few (0 < min 1)', !phases.resolveGenericChoice(G, []).ok);
  check('rejects too many (3 > max 2)', !phases.resolveGenericChoice(G, ['a', 'b', 'c']).ok);
  check('rejects duplicate ids', !phases.resolveGenericChoice(G, ['a', 'a']).ok);
  // Still pending after every rejection (nothing consumed).
  check('choice still pending after rejections', G.pendingChoice?.kind === 'Choice');
  const ok = phases.resolveGenericChoice(G, ['a', 'b']).ok;
  check('accepts a valid selection', ok);
  check('resolver received the selection', JSON.stringify(ran) === JSON.stringify(['a', 'b']));
  check('pendingChoice cleared after resolve', !G.pendingChoice);

  // Unknown tag => clean rejection, not a throw.
  choices.requestChoice(G, {
    tag: '__missing_tag', side: 'Rebel', domain: 'option',
    prompt: 'x', candidates: [{ id: 'a', label: 'A' }], min: 0, max: 1,
  });
  check('rejects a tag with no registered resolver', !phases.resolveGenericChoice(G, ['a']).ok);
}

// ---------------------------------------------------------------------------
console.log('The Long War — choose which 2 objectives to discard (#424/#462):');
{
  const G = createGame(data, opts(2));
  // Mimic post-removal hand (the played card is spliced out before the side
  // effect runs): 4 *other* objectives to choose 2 discards from.
  G.rebel.objectiveHand = ['establish-outposts-3', 'uprising-3', 'heart-of-the-empire-2', 'threaten-the-core-1'];
  G.rebel.objectiveDiscard = [];
  phases.applyObjectiveScoreSideEffect(G, 'the-long-war-1', 7);

  const pc = G.pendingChoice;
  check('raises a generic Choice', pc?.kind === 'Choice');
  check('tag = the-long-war-discard', pc?.tag === 'the-long-war-discard');
  check('domain = card', pc?.domain === 'card');
  check('min 2 / max 2', pc?.min === 2 && pc?.max === 2);
  check('candidates are the 4 other objectives', pc?.candidates.length === 4
    && pc.candidates.every((c) => G.rebel.objectiveHand.includes(c.id)));
  check('did NOT auto-discard anything yet', G.rebel.objectiveDiscard.length === 0);

  const r = phases.resolveGenericChoice(G, ['uprising-3', 'threaten-the-core-1']);
  check('resolve ok', r.ok);
  check('exactly the 2 chosen were discarded',
    G.rebel.objectiveDiscard.includes('uprising-3') && G.rebel.objectiveDiscard.includes('threaten-the-core-1')
    && G.rebel.objectiveDiscard.length === 2);
  check('the 2 UNchosen stay in hand',
    G.rebel.objectiveHand.includes('establish-outposts-3') && G.rebel.objectiveHand.includes('heart-of-the-empire-2'));
  check('the 2 chosen left the hand',
    !G.rebel.objectiveHand.includes('uprising-3') && !G.rebel.objectiveHand.includes('threaten-the-core-1'));
  // The resolver consumes its OWN choice and resumes the Refresh — a later
  // Refresh step may raise a fresh choice, so assert only that the-long-war
  // discard choice is gone (resume happened), not that pendingChoice is null.
  check('the-long-war discard choice consumed (resume ran)',
    !(G.pendingChoice?.kind === 'Choice' && G.pendingChoice.tag === 'the-long-war-discard'));
}

// ---------------------------------------------------------------------------
console.log('The Long War — exactly 2 others: no prompt, auto-discard both:');
{
  const G = createGame(data, opts(3));
  G.rebel.objectiveHand = ['establish-outposts-3', 'uprising-3'];
  G.rebel.objectiveDiscard = [];
  phases.applyObjectiveScoreSideEffect(G, 'the-long-war-1', 7);
  check('no choice raised', !G.pendingChoice);
  check('both discarded automatically', G.rebel.objectiveDiscard.length === 2);
  check('hand emptied of the two', G.rebel.objectiveHand.length === 0);
}

// ---------------------------------------------------------------------------
console.log('Plan The Assault — revealed-base source contract (#427/#457):');
{
  const G = createGame(data, opts(4));
  handlers.registerAll?.();
  // Reveal the base: its ships now live in the real system, not rebel-base-space.
  G.rebelBaseRevealed = true;
  const baseSys = G.rebelBaseSystemId;
  check('has a resolved base system', typeof baseSys === 'string' && !!G.map.systems[baseSys]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

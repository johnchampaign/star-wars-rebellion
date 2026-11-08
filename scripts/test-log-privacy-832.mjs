// #832: an Empire player could read the AI Rebel's Stolen Plans reorder ("order:
// Crippling Blow, Defend The People, ...") straight off the on-screen log, and
// the Covert Operation keep/bottom pick the same way. Both are now owner-only:
// the side that looked can re-read them, the opponent never sees them.
// Run: node scripts/test-log-privacy-832.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const src = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf8');
const setOf = (name) => {
  const m = src.match(new RegExp(`const ${name} = new Set<string>\\(\\[([\\s\\S]*?)\\]\\);`));
  return new Set(m ? [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((x) => x[1]) : []);
};
const OWNER_ONLY = setOf('OWNER_ONLY_KINDS');
const HIDDEN = setOf('ONSCREEN_HIDDEN_KINDS');
// Mirror of logVisibility().visible.
const visible = (e, human) => (OWNER_ONLY.has(e.kind) ? e.side === human : !HIDDEN.has(e.kind));

for (const kind of ['stolen-plans-reorder', 'covert-operation-pick']) {
  check(`${kind} is hidden from the Empire`, !visible({ kind, side: 'Rebel' }, 'Empire'));
  check(`${kind} stays readable for the Rebel`, visible({ kind, side: 'Rebel' }, 'Rebel'));
}
check('a tactic-deck reorder by the Empire is hidden from the Rebel', !visible({ kind: 'stolen-plans-reorder', side: 'Empire' }, 'Rebel'));
check('Interrogation still owner-only', !visible({ kind: 'interrogation-reveal', side: 'Empire' }, 'Rebel') && visible({ kind: 'interrogation-reveal', side: 'Empire' }, 'Empire'));
check('the visibility rule still reads OWNER_ONLY_KINDS first', /visible: \(e\) => \(OWNER_ONLY_KINDS\.has\(e\.kind\) \? e\.side === humanSide : !ONSCREEN_HIDDEN_KINDS\.has\(e\.kind\)\)/.test(src));

const eng = readFileSync(join(ROOT, 'src/engine/phases.ts'), 'utf8');
check('the engine still logs these kinds (names match)', eng.includes("kind: 'stolen-plans-reorder'") && eng.includes("kind: 'covert-operation-pick'"));

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

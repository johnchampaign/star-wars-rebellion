// Moving the Death Star site during setup must only box the FINAL site's probe:
// the abandoned remote goes back in the probe deck and the Rebel's base choices.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'),
  actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'),
  tactics: lj('tactics.json'), probes: lj('probes.json'),
};

let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };

const DSUC = 'death-star-under-construction';
const newGame = (seed) => createGame(data, { seed, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true } });
const remotes = (G) => Object.keys(G.map.systems).filter((id) => G.catalog.systems[id]?.isRemote);
const probeOf = (G, sys) => Object.values(G.catalog.probes).find((p) => p.systemId === sys);
const inDeck = (G, sys) => G.probeDeck.includes(probeOf(G, sys).id);
const pullDsuc = (G, sys) => phases.setupUndoDeployUnit(G, 'Empire', DSUC, sys);
const finishSetup = (G, base) => {
  phases.setupAutoFill(G, 'Empire');
  phases.setupAutoFill(G, 'Rebel');
  return phases.pickRebelBase(G, base ?? G.pendingRebelBasePick.find((s) => s !== G.rebelBaseSystemId));
};
// Every probe is in the deck exactly once, except the Imperial worlds', the
// base's and the final Death Star site's.
const deckProblems = (G) => {
  const boxed = new Set([G.rebelBaseSystemId, G.empireDeployTarget]);
  for (const [id, ss] of Object.entries(G.map.systems)) if (ss.loyalty === 'imperial' || ss.subjugated) boxed.add(id);
  const out = [];
  if (new Set(G.probeDeck).size !== G.probeDeck.length) out.push('duplicate card');
  for (const p of Object.values(G.catalog.probes)) {
    const want = !boxed.has(p.systemId);
    if (G.probeDeck.includes(p.id) !== want) out.push(`${p.systemId} ${want ? 'missing' : 'should be boxed'}`);
  }
  return out;
};

console.log('[ pulling the site back returns its probe and base option ]');
{
  const G = newGame(3);
  const [a] = remotes(G).filter((s) => s !== G.rebelBaseSystemId);
  const deckSize = G.probeDeck.length;
  phases.setupDeployUnit(G, 'Empire', DSUC, a);
  check('claiming the site boxes its probe', !inDeck(G, a));
  check('and drops it from the base choices', !G.pendingRebelBasePick.includes(a));
  pullDsuc(G, a);
  check('site released', G.empireDeployTarget == null, G.empireDeployTarget);
  check('probe is back in the deck', inDeck(G, a));
  check('deck is back to its original size', G.probeDeck.length === deckSize, G.probeDeck.length);
  check('base option is back', G.pendingRebelBasePick.includes(a));
}

console.log('[ moving the site boxes only the final one, and the old one can be the base ]');
{
  const G = newGame(3);
  const [a, b] = remotes(G).filter((s) => s !== G.rebelBaseSystemId);
  phases.setupDeployUnit(G, 'Empire', DSUC, a);
  pullDsuc(G, a);
  phases.setupDeployUnit(G, 'Empire', DSUC, b);
  check('new site is boxed', !inDeck(G, b) && !G.pendingRebelBasePick.includes(b));
  check('old site is not', inDeck(G, a) && G.pendingRebelBasePick.includes(a));
  const r = finishSetup(G, a);
  check('Rebel can base on the abandoned site', r.ok, r.reason);
  check('deck is exactly right', deckProblems(G).length === 0, deckProblems(G).join());
}

console.log('[ a site held by leftover reinforcements stays claimed ]');
{
  const G = newGame(3);
  const [a] = remotes(G).filter((s) => s !== G.rebelBaseSystemId);
  phases.setupDeployUnit(G, 'Empire', DSUC, a);
  phases.setupDeployUnit(G, 'Empire', 'tie-fighter', a);
  pullDsuc(G, a);
  check('site still claimed', G.empireDeployTarget === a, G.empireDeployTarget);
  check('probe stays boxed', !inDeck(G, a));
  phases.setupUndoDeployUnit(G, 'Empire', 'tie-fighter', a);
  check('last unit out releases it', G.empireDeployTarget == null && inDeck(G, a));
}

console.log('[ a site that was also the placeholder base ]');
{
  let seed = 1, G = newGame(seed);
  while (!remotes(G).includes(G.rebelBaseSystemId) && seed < 500) G = newGame(++seed);
  const a = G.rebelBaseSystemId;
  check('found a game whose placeholder base is remote', remotes(G).includes(a), seed);
  phases.setupDeployUnit(G, 'Empire', DSUC, a);
  check('placeholder moved off the site', G.rebelBaseSystemId !== a, G.rebelBaseSystemId);
  pullDsuc(G, a);
  check('its probe joins the deck', inDeck(G, a));
  check('base option is back', G.pendingRebelBasePick.includes(a));
  const r = finishSetup(G);
  check('setup finishes', r.ok, r.reason);
  check('deck is exactly right', deckProblems(G).length === 0, deckProblems(G).join());
}

console.log('[ a pull-back after the Rebel has committed the base ]');
{
  const G = newGame(3);
  const [a, b] = remotes(G).filter((s) => s !== G.rebelBaseSystemId);
  phases.setupDeployUnit(G, 'Empire', DSUC, a);
  // Leave one Empire unit pending so setup stays open after the base pick path.
  phases.setupAutoFill(G, 'Empire');
  const base = G.pendingRebelBasePick.find((s) => s !== a && s !== b);
  check('Rebel commits', phases.pickRebelBase(G, base).ok);
  pullDsuc(G, a);
  check('no base choice list reappears', G.pendingRebelBasePick === undefined);
  check('probe is back in the deck', inDeck(G, a));
  check('the committed base stays out of the deck', !inDeck(G, base));
}

console.log('[ fuzz: any number of site moves leaves the right deck ]');
{
  const GAMES = 200;
  let bad = 0, moves = 0, stuck = 0;
  for (let seed = 1; seed <= GAMES; seed++) {
    const G = newGame(seed);
    let x = seed * 2654435761 >>> 0;
    const rnd = (n) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x % n; };
    const rs = remotes(G);
    let site = null;
    for (let i = 1 + rnd(5); i > 0; i--) {
      site = rs[rnd(rs.length)];
      phases.setupDeployUnit(G, 'Empire', DSUC, site);
      if (i > 1) { pullDsuc(G, site); moves++; }
    }
    const r = finishSetup(G);
    if (!r.ok) { stuck++; continue; }
    if (deckProblems(G).length) bad++;
  }
  check('the fuzz actually moved sites', moves > 200, moves);
  check(`all ${GAMES} games finished setup`, stuck === 0, `${stuck} stuck`);
  check('every deck is exactly right', bad === 0, `${bad} wrong`);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

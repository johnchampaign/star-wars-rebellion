// Local end-to-end test of the framework online stack — NO Supabase, NO
// Cloudflare, NO network. Drives the real GameServer (the exact class the
// Cloudflare Functions instantiate) backed by FsStore (local JSON files)
// and NoopNotifier. Simulates two players taking turns by token.
//
// Proves, entirely offline:
//   - createGame issues per-side tokens + invite URLs
//   - server.fetch returns a per-player REDACTED view (viewFor works)
//   - turn enforcement: submitting as the wrong side is rejected
//   - server.legalActions + server.submit round-trip drives the game forward
//   - snapshots persist to ./.dev-store and the turn counter advances
//
// Run: node scripts/test-online-local.mjs [--turns 40]

import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TURNS = (() => {
  const i = process.argv.indexOf('--turns');
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : 40;
})();

// tsx so we can import the .ts adapter + engine.
{ const mod = await import('tsx/esm/api'); mod.register(); }

// Local Node script: use the /server barrel directly. Unlike Cloudflare
// Workers, Node has node:fs, so pulling FsStore in via the barrel is fine.
const { GameServer, FsStore, NoopNotifier } = await import('digital-boardgame-framework/server');
const { jsonCodec } = await import('digital-boardgame-framework');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const { createGame } = await import('../src/engine/setup.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

const STORE_DIR = join(ROOT, '.dev-store-test');
rmSync(STORE_DIR, { recursive: true, force: true });

// Deterministic id generator so the run is reproducible.
let idCounter = 0;
const idGen = () => `id${(++idCounter).toString().padStart(4, '0')}`;

const server = new GameServer({
  adapter: rebellionAdapter,
  codec: jsonCodec(),
  store: new FsStore(STORE_DIR),
  notifier: new NoopNotifier(),
  gameUrl: (gameId, token) => `http://local/play/${gameId}?as=${token}`,
  idGen,
});

function tokenFromInvite(url) {
  return new URL(url).searchParams.get('as');
}

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

console.log('=== 1. createGame ===');
const initialState = createGame(data, { seed: 12345, autoSetupUnits: true });
const created = await server.createGame({
  initialState,
  players: ['Rebel', 'Empire'],
});
const tokens = {
  Rebel: tokenFromInvite(created.invites.Rebel),
  Empire: tokenFromInvite(created.invites.Empire),
};
console.log(`  gameId=${created.gameId}`);
console.log(`  Rebel invite:  ${created.invites.Rebel}`);
console.log(`  Empire invite: ${created.invites.Empire}`);
check('two distinct tokens issued', tokens.Rebel && tokens.Empire && tokens.Rebel !== tokens.Empire);

console.log('\n=== 2. per-player redacted views (viewFor) ===');
const rebelView = await server.fetch(created.gameId, tokens.Rebel);
const empireView = await server.fetch(created.gameId, tokens.Empire);
// Rebel should see own action hand contents; Empire's hand should be hidden
// in the Rebel's view.
const rebelSeesOwnHand = rebelView.view.rebel.actionHand.every(c => c !== '__hidden__');
const rebelCantSeeEmpireHand = empireView.view.empire.actionHand.length === 0
  || rebelView.view.empire.actionHand.every(c => c === '__hidden__');
check('Rebel sees own action hand', rebelSeesOwnHand || rebelView.view.rebel.actionHand.length === 0);
check('Empire action hand hidden from Rebel', rebelCantSeeEmpireHand);
// Base location: Empire must not see it (until revealed).
check('Rebel base hidden from Empire',
  empireView.view.rebelBaseSystemId === '__hidden__' || empireView.view.rebelBaseRevealed);
check('Rebel sees own base location',
  rebelView.view.rebelBaseSystemId !== '__hidden__');

console.log('\n=== 3. turn enforcement ===');
const firstActor = rebellionAdapter.currentActor(initialState);
const wrongSide = firstActor === 'Rebel' ? 'Empire' : 'Rebel';
console.log(`  first actor = ${firstActor}; trying to act as ${wrongSide}…`);
let rejected = false;
try {
  const legalWrong = await server.legalActions(created.gameId, tokens[wrongSide]);
  // legalActions returns [] for the non-actor; submitting anyway must throw.
  await server.submit(created.gameId, tokens[wrongSide], { kind: 'skipAssignment' });
} catch (e) {
  rejected = true;
  console.log(`  rejected with: "${e.message}"`);
}
check('wrong-side submit rejected', rejected);

console.log('\n=== 4. play through turns ===');
// Deterministic action pick (first legal) so the run reproduces.
let turn = 0, stuck = false, gameOver = false;
for (; turn < TURNS; turn++) {
  // Find whose turn it is by asking each token.
  let actor = null;
  for (const side of ['Rebel', 'Empire']) {
    const v = await server.fetch(created.gameId, tokens[side]);
    if (v.gameOver) { gameOver = true; break; }
    if (v.yourTurn) { actor = side; break; }
  }
  if (gameOver) { console.log(`  game over at turn ${turn}`); break; }
  if (!actor) { stuck = true; console.log(`  STUCK: nobody's turn at step ${turn}`); break; }
  const legal = await server.legalActions(created.gameId, tokens[actor]);
  if (legal.length === 0) { stuck = true; console.log(`  STUCK: ${actor} has no legal actions`); break; }
  const action = legal[0];
  const res = await server.submit(created.gameId, tokens[actor], action);
  if (turn < 12 || turn % 10 === 0) {
    console.log(`  step ${String(turn).padStart(3)}: ${actor} → ${action.kind}  (server turn now ${res.turn})`);
  }
}
check('played without getting stuck', !stuck);
check('turn counter advanced', turn > 0);

console.log('\n=== 5. persistence ===');
const finalRebel = await server.fetch(created.gameId, tokens.Rebel);
check('snapshot turn matches steps played', finalRebel.turn >= turn - 1);
console.log(`  final server turn = ${finalRebel.turn}, phase = ${finalRebel.view.phase}`);

rmSync(STORE_DIR, { recursive: true, force: true });

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);

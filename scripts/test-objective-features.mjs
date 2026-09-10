// @timeout 120000
// Objective-aware ranker features (2026-09-10, John's option 1 for the Rebel
// objective ladder: humans score a stage-3 objective in 40% of games, the AI in
// 8%). objectiveMatches() maps each candidate to the in-hand objectives it
// plausibly advances. This pins the mapping on synthetic boards, the Empire and
// empty-hand zero cases, and the trainer's A/B switch (SWR_OBJ_FEATURES=0 → all
// zero in a child), so a retrain can be compared like for like. Measured flat on
// 2026-09-10 (held-out top-1 27.5% → 26.8%), so the helper is a measurement tool
// and is NOT in the shipped feature vector.
// Run: node scripts/test-objective-features.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const F = await import('../src/play/candidateFeatures.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
let k = 0; const mk = (typeId, side) => ({ instanceId: `t${k++}`, typeId, side, damage: 0 });
function board() {
  const G = createGame(data, { seed: 9, autoSetupUnits: true });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  return G;
}
const attack = (tgt) => ({ kind: 'activate', leaderId: 'mon-mothma', targetSystemId: tgt, score: 10 });
const reveal = (mid, tgt) => ({ kind: 'reveal', missionId: mid, targetSystemId: tgt, score: 10 });

if (process.env.OBJ_CHILD === '1') {
  const G = board(); G.rebel.objectiveHand = ['rebel-assault-1']; G.map.systems['corellia'].units.push(mk('star-destroyer', 'Empire'));
  console.log(JSON.stringify(F.objectiveMatches(G, 'Rebel', attack('corellia')))); process.exit(0);
}
console.log('[ combat objectives key on what stands at the target ]');
{
  const G = board(); G.rebel.objectiveHand = ['rebel-assault-1', 'crippling-blow-1', 'major-victory-3'];
  G.map.systems['corellia'].units.push(mk('star-destroyer', 'Empire'), mk('stormtrooper', 'Empire'));
  const m = F.objectiveMatches(G, 'Rebel', attack('corellia'));
  check('Star Destroyer at the target: Rebel Assault + Major Victory (ships ≥3 hp) match, Crippling Blow (ground ≥3 hp) does not', m.combat === 2 && m.matchedStage3 === 1, JSON.stringify(m));
  check('reputation at stake sums the matched cards', m.rep === 2, JSON.stringify(m));
  const m2 = F.objectiveMatches(G, 'Rebel', attack('naboo'));
  check('an activation to an empty system matches no combat objective', m2.combat === 0, JSON.stringify(m2));
  G.rebel.objectiveHand = ['return-of-the-jedi-3']; G.empire.leadersOnBoard['corellia'] = ['emperor-palpatine'];
  check('Return of the Jedi matches an attack where Palpatine stands', F.objectiveMatches(G, 'Rebel', attack('corellia')).combat === 1);
}
console.log('[ loyalty, presence, sabotage and rescue families ]');
{
  const G = board(); G.rebel.objectiveHand = ['popular-support-2', 'establish-outposts-3', 'cut-supply-lines-1', 'leave-no-one-behind-2'];
  for (const ss of Object.values(G.map.systems)) if (ss.loyalty === 'rebel') ss.loyalty = 'neutral';
  const loy = F.objectiveMatches(G, 'Rebel', reveal('build-alliance', 'naboo'));
  check('a loyalty mission matches Popular Support while fewer than 6 systems are Rebel-loyal', loy.loyalty === 1 && loy.combat === 0, JSON.stringify(loy));
  const pres = F.objectiveMatches(G, 'Rebel', attack('naboo'));
  check('moving into a system with no Rebel unit matches Establish Outposts', pres.presence >= 1, JSON.stringify(pres));
  G.map.systems['corellia'].loyalty = 'imperial';
  const sab = F.objectiveMatches(G, 'Rebel', reveal('sabotage', 'corellia'));
  check('Sabotage on an Imperial system matches Cut Supply Lines', sab.sabotage === 1, JSON.stringify(sab));
  G.empire.capturedLeaders = [{ leaderId: 'han-solo', ring: 'captured', systemId: 'corellia' }];
  const res = F.objectiveMatches(G, 'Rebel', reveal('daring-rescue', 'corellia'));
  check('a rescue mission matches Leave No One Behind while a leader is held', res.rescue === 1, JSON.stringify(res));
}
console.log('[ zero cases ]');
{
  const G = board(); G.rebel.objectiveHand = ['rebel-assault-1']; G.map.systems['corellia'].units.push(mk('star-destroyer', 'Empire'));
  const e = F.objectiveMatches(G, 'Empire', attack('corellia'));
  check('the Empire never gets objective features', Object.values(e).every((v) => v === 0));
  G.rebel.objectiveHand = [];
  check('an empty hand is all zeros', Object.values(F.objectiveMatches(G, 'Rebel', attack('corellia'))).every((v) => v === 0));
  const out = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, OBJ_CHILD: '1', SWR_OBJ_FEATURES: '0' }, encoding: 'utf8' }).trim().split('\n').pop());
  check('SWR_OBJ_FEATURES=0 (trainer A/B) zeroes them in a child', Object.values(out).every((v) => v === 0), JSON.stringify(out));
  const names = F.featureNames(G);
  check('the objective features are NOT in the shipped vector (measured flat; see candidateFeatures.ts)', !names.some((n) => n.startsWith('obj')));
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

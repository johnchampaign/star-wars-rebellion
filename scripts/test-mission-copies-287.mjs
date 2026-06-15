import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const missionsJson = loadJson('missions.json');
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: missionsJson, objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
const copiesOf = Object.fromEntries((missionsJson.missions||missionsJson).map(m=>[m.id, m.copies||1]));
let pass=0,fail=0; const check=(n,ok,x='')=>{console.log(`  ${ok?'✓':'✗'} ${n}${ok?'':' — '+x}`);ok?pass++:fail++;};

function countInPlay(G, side){
  const f = side==='Rebel'?G.rebel:G.empire;
  const all=[...(f.missionDeck||[]), ...(f.missionHand||[])];
  const c=new Map(); for(const id of all) c.set(id,(c.get(id)||0)+1); return c;
}

for (const [label, opts] of [['BASE',{roeMissions:false,roeUnits:false}],['RoE',{roeMissions:true,roeUnits:true}]]) {
  const G = createGame(data, { seed: 5, ...opts });
  let bad=[];
  for (const side of ['Rebel','Empire']) {
    const cnt = countInPlay(G, side);
    for (const [id, n] of cnt) {
      const expect = copiesOf[id] ?? 1;
      if (n !== expect) bad.push(`${side} ${id}: have ${n}, expect ${expect}`);
    }
  }
  check(`${label}: every present mission appears exactly its 'copies' times`, bad.length===0, bad.slice(0,5).join('; '));
  // spot-check a couple known multi-copy missions if present
  const reb = countInPlay(G,'Rebel'); const emp = countInPlay(G,'Empire');
  if (reb.has('hidden-fleet')) check(`${label}: Hidden Fleet x3`, reb.get('hidden-fleet')===3, `got ${reb.get('hidden-fleet')}`);
  if (reb.has('safe-haven')) check(`${label}: Safe Haven x2`, reb.get('safe-haven')===2, `got ${reb.get('safe-haven')}`);
  if (emp.has('interrogation')) check(`${label}: Interrogation x2`, emp.get('interrogation')===2, `got ${emp.get('interrogation')}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

// #747 / #749 — "the dsuc somehow still has 4 red hp - actually, it has 4 black
// hp (see the original board game)."
//
// The reporter is right. On the 2-player battle mat (images/ReferenceEmpire2P.png)
// the Death Star Under Construction's health pip is the BLACK/gear icon; the
// Star Destroyer's red-4 pip two rows above it is a visibly red circle. Health
// colour decides which damage a unit can take, so a red-4 DSUC could only be
// hurt by direct hits — far more durable than the card it is printed on.
//
// This pins every unit's health colour and value against those two mats, so the
// next transcription slip is caught at the table rather than in a play report.
// Run: node scripts/test-unit-health-colors-747.mjs
const { register } = await import('tsx/esm/api');
register();
const { UNIT_TYPES } = await import('../src/engine/units.ts');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

// Transcribed from images/ReferenceEmpire2P.png and images/ReferenceRebel2P.png.
// `null` = cannot be damaged at all (the completed Death Star).
const EXPECTED = {
  // Imperial — base
  'tie-fighter': ['black', 1],
  'assault-carrier': ['red', 2],
  'star-destroyer': ['red', 4],
  'super-star-destroyer': ['red', 6],
  'death-star': [null, 0],
  'death-star-under-construction': ['black', 4], // #747: was wrongly 'red'
  'stormtrooper': ['black', 1],
  'at-st': ['red', 2],
  'at-at': ['red', 3],
  // Imperial — Rise of the Empire
  'tie-striker': ['black', 1],
  'assault-tank': ['red', 1],
  'shield-bunker': ['red', 3],
  'interdictor': ['red', 4],
  // Rebel — base
  'x-wing': ['black', 1],
  'y-wing': ['black', 1],
  'corellian-corvette': ['red', 2],
  'rebel-transport': ['red', 2],
  'mon-cala-cruiser': ['red', 4],
  'rebel-trooper': ['black', 1],
  'airspeeder': ['red', 2],
  'shield-generator': ['red', 3],
  'ion-cannon': ['red', 3],
  // Rebel — Rise of the Empire
  'u-wing': ['black', 1],
  'nebulon-b-frigate': ['red', 3],
  'rebel-vanguard': ['black', 1],
  'golan-arms-turret': ['red', 3],
};

const byId = Object.fromEntries(UNIT_TYPES.map((u) => [u.id, u]));

console.log('\n[ #747: DSUC health is BLACK 4, not red ]');
{
  const d = byId['death-star-under-construction'];
  check('DSUC exists', !!d);
  check('DSUC health colour is black', d?.health.color === 'black', `got ${d?.health.color}`);
  check('DSUC health value is 4', d?.health.value === 4, `got ${d?.health.value}`);
  // The contrast that makes the mat unambiguous: the SD on the same sheet is red.
  check('Star Destroyer is still RED (the mat contrast)',
    byId['star-destroyer']?.health.color === 'red');
}

console.log('\n[ every unit matches the 2-player battle mats ]');
for (const [id, [color, value]] of Object.entries(EXPECTED)) {
  const u = byId[id];
  if (!u) { check(`${id} present in the catalog`, false); continue; }
  check(`${id}: ${color ?? 'undamageable'} ${value}`,
    u.health.color === color && u.health.value === value,
    `got ${u.health.color} ${u.health.value}`);
}

console.log('\n[ the table covers the whole catalog ]');
{
  const missing = UNIT_TYPES.map((u) => u.id).filter((id) => !(id in EXPECTED));
  check('no unit type is unpinned', missing.length === 0, `unpinned: ${missing.join(', ')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

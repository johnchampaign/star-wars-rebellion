// Refuses to build when node_modules doesn't match package-lock.json.
// A checkout whose install had fallen behind once shipped Rebellion and
// War of the Ring with an old framework while package.json asked for the
// new one; the build itself succeeds either way, so nothing else catches it.
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pkg = read('package.json');
const lock = read('package-lock.json');
const stale = [];
for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  const want = lock.packages?.[`node_modules/${name}`]?.version;
  if (!want) continue; // linked or aliased dependency: nothing to compare
  let have = 'missing';
  try { have = read(`node_modules/${name}/package.json`).version; } catch {}
  if (have !== want) stale.push(`${name}: installed ${have}, package-lock.json wants ${want}`);
}
if (stale.length) {
  console.error(`node_modules is out of date:\n  ${stale.join('\n  ')}\nRun \`npm ci\`, then build again.`);
  process.exit(1);
}

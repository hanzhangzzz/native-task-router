// Run without arguments for the source checkout, or pass Contents/Resources/app after packaging.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.argv[2] || source);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (root === source) assert.ok(!pkg.build.files.includes('entry/**'), 'entry packaging must use an explicit allowlist');
assert.ok(!pkg.dependencies?.['native-task-router-remote'], 'private add-on must not be a public dependency');
for (const relative of ['entry/remote.cjs', 'entry/remote.html', 'scripts/remote.contracts.mjs', 'addon', 'addons']) {
  assert.ok(!fs.existsSync(path.join(root, relative)), `private implementation leaked: ${relative}`);
}
let files = 0;
function inspect(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) inspect(file);
    else if (/\.(?:cjs|mjs|ts|html)$/.test(item.name)) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/createRemoteServer|NTR_REMOTE_PORT|ntr-token|ServerAliveInterval|\/api\/(?:open|tasks)|permitlisten|['"]\/usr\/bin\/ssh['"]/.test(text), `private transport in ${path.relative(root, file)}`);
      files++;
    }
  }
}
inspect(path.join(root, 'entry'));
inspect(path.join(root, 'src'));
console.log(`PASS local package boundary: ${files} source files checked, no private remote implementation`);

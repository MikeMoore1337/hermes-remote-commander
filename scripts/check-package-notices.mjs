import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const notice = readFileSync('NOTICE');
const license = readFileSync('LICENSE');
for (const name of ['agent', 'relay', 'shared']) {
  const metadata = JSON.parse(readFileSync(`packages/${name}/package.json`));
  const archive = `dist-pack/brc-${name}-${metadata.version}.tgz`;
  const read = file => execFileSync('tar', ['-xOzf', archive, `package/${file}`]);
  const packed = JSON.parse(read('package.json'));
  assert.equal(packed.repository.url, 'https://github.com/MikeMoore1337/hermes-remote-commander.git');
  assert.equal(packed.repository.directory, `packages/${name}`);
  assert.equal(packed.homepage, 'https://github.com/MikeMoore1337/hermes-remote-commander#readme');
  if (name !== 'shared') assert.doesNotMatch(read('README.md').toString(), /npm i -g brc-(agent|relay)/);
  assert.deepEqual(read('NOTICE'), notice, `${name} NOTICE differs from the root`);
  assert.deepEqual(read('LICENSE'), license, `${name} LICENSE differs from the root`);
  if (name === 'agent') {
    for (const file of ['THIRD_PARTY_NOTICES.md', 'licenses/GPL-3.0.txt', 'licenses/LGPL-3.0.txt']) {
      assert.deepEqual(read(file), readFileSync(`packages/agent/${file}`), `agent ${file} differs`);
    }
  }
}
console.log('PACKAGE_NOTICES=PASS');

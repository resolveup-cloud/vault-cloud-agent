import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const image = process.env.VAULT_NODE_IMAGE_TEST;
test('built Cloud Agent supports the pinned Claude Node engine', { skip: !image }, () => {
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node',
    image, '-p', 'process.versions.node'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, 'isolated image Node probe failed');
  const version = result.stdout.trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number(version.split('.')[0]) >= 22,
    `Claude Code requires Node >=22; the built image contains ${version}`);
});

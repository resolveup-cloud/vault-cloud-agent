import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const subject = await import('../lib/config.mjs').catch(() => ({}));

test('private ingress defaults to loopback and refuses public/wildcard/DNS targets', () => {
  assert.equal(typeof subject.parseOptions, 'function');
  assert.equal(subject.parseOptions(['install']).bind, '127.0.0.1');
  for (const bind of ['0.0.0.0', '8.8.8.8', 'vault.example.com', '::', '::ffff:8.8.8.8']) {
    assert.throws(() => subject.parseOptions(['install', '--bind', bind]), /private|loopback/);
  }
  for (const bind of ['100.64.1.20', '192.168.1.2', '10.0.0.3', '172.16.0.9', '::1', 'fd00::2']) {
    assert.equal(subject.parseOptions(['install', '--bind', bind]).bind, bind);
  }
  assert.throws(() => subject.parseOptions(['start', '--bind', '100.64.1.20']), /install/);
  assert.throws(() => subject.parseOptions(['install', '--port', '0']), /port/);
  assert.throws(() => subject.parseOptions(['install', '--unknown']), /Unknown/);
});

test('config persists with restrictive modes and explicit project access', async () => {
  assert.equal(typeof subject.createConfig, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'vault-agent-config-'));
  const project = join(dir, 'my project');
  await mkdir(project);
  const opts = subject.parseOptions(['install', '--project', project]);
  const config = await subject.createConfig(opts);
  assert.equal(config.projects[0].readOnly, true);
  assert.equal(config.projects[0].source, await realpath(project));
  assert.match(config.projects[0].target, /^\/projects\/1-/);
  const writable = await subject.createConfig(subject.parseOptions(['install', '--writable-project', project]));
  assert.equal(writable.projects[0].readOnly, false);
  await subject.saveConfig(join(dir, 'state'), config);
  const loaded = await subject.loadConfig(join(dir, 'state'));
  assert.deepEqual(loaded, config);
  assert.equal((await stat(join(dir, 'state'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'state', 'config.json'))).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(join(dir, 'state', 'config.json'), 'utf8'), /token|pairingCode/);
});

test('Docker mount delimiters and non-directories are refused', async () => {
  assert.equal(typeof subject.createConfig, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'vault-agent-mount-'));
  await mkdir(join(dir, 'bad,name'));
  await assert.rejects(subject.createConfig(subject.parseOptions(['install', '--project', join(dir, 'bad,name')])), /comma|delimiter/);
  await assert.rejects(subject.createConfig(subject.parseOptions(['install', '--project', join(dir, 'missing')])), /directory/);
});

test('local device approval requires a specific device and explicit capability flags', () => {
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  assert.deepEqual(subject.parseOptions(['approve', id, '--terminals', '--files']).grants, ['--terminals', '--files']);
  assert.throws(() => subject.parseOptions(['approve', id]), /permission|capability/);
  assert.throws(() => subject.parseOptions(['approve', 'all', '--terminals']), /device/);
  assert.throws(() => subject.parseOptions(['approve', id, '--bypass-all']), /Unknown/);
  assert.equal(subject.parseOptions(['revoke', id]).deviceId, id);
});

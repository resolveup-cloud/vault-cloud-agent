import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const subject = await import('../lib/cli.mjs').catch(() => ({}));

function fakeDocker() {
  const calls = [];
  let container = null;
  let volume = null;
  return { calls, run: async (args) => {
    calls.push(args);
    if (args[0] === 'info') return args.at(-1) === '{{json .Runtimes}}' ? '{"runsc":{"path":"runsc"}}' : 'linux/x86_64';
    if (args[0] === 'build') return '';
    if (args[0] === 'image') return 'sha256:' + 'a'.repeat(64);
    if (args[0] === 'volume') {
      if (args[1] === 'ls') return volume?.Name ?? '';
      if (args[1] === 'create') { volume = { Name: args.at(-1), Labels: { 'dev.vault.cloud-agent.owner': args[3].split('=')[1] } }; return volume.Name; }
      return JSON.stringify([volume]);
    }
    if (args[0] === 'run') {
      const owner = args[args.indexOf('--label') + 1].split('=')[1];
      container = { HostConfig: { Runtime: args.includes('--runtime=runsc') ? 'runsc' : 'runc' }, Config: { Labels: { 'dev.vault.cloud-agent.owner': owner }, Env: ['SECRET=should-not-print'] }, State: { Status: 'running', Running: true, Health: { Status: 'healthy' } } };
      return 'container-id';
    }
    if (args[0] === 'container' && args[1] === 'ls') return container ? calls.find((x) => x[0] === 'run')[calls.find((x) => x[0] === 'run').indexOf('--name') + 1] : '';
    if (args[0] === 'container') return JSON.stringify([container]);
    if (args[0] === 'stop') { container.State.Status = 'exited'; container.State.Running = false; return ''; }
    if (args[0] === 'start') { container.State.Status = 'running'; container.State.Running = true; return ''; }
    throw new Error('Unexpected Docker command');
  } };
}

test('install refuses absent or unverifiable gVisor before persisting config, building, or creating a volume', async () => {
  for (const runtimes of ['{}', '{"runc":{}}', '{"runsc":null}', '{"runsc":"runsc"}', '{"runsc":[]}', '[]', 'null', 'not-json']) {
    const state = await mkdtemp(join(tmpdir(), 'vault-agent-no-runsc-'));
    const calls = [];
    await assert.rejects(subject.runCli(['install', '--state-dir', state, '--json'], {
      write: () => {}, run: async (args) => {
        calls.push(args);
        if (args[0] === 'info') return args.at(-1) === '{{json .Runtimes}}' ? runtimes : 'linux/x86_64';
        throw new Error('must not mutate Docker');
      },
    }), /gVisor.*runsc.*https:\/\/gvisor\.dev\/docs\/user_guide\/quick_start\/docker\//);
    assert.ok(calls.every((args) => args[0] === 'info'));
    await assert.rejects(access(join(state, 'config.json')), { code: 'ENOENT' });
  }
});

test('start and repeat install refuse a removed gVisor runtime without changing existing data', async () => {
  const state = await mkdtemp(join(tmpdir(), 'vault-agent-lost-runsc-'));
  const fake = fakeDocker();
  const deps = { run: fake.run, write: () => {} };
  await subject.runCli(['install', '--state-dir', state, '--json'], deps);
  await subject.runCli(['start', '--state-dir', state, '--json'], deps);
  await subject.runCli(['stop', '--state-dir', state, '--json'], deps);
  const original = await readFile(join(state, 'config.json'), 'utf8');
  const mutations = [];
  const unavailable = { write: () => {}, run: async (args) => {
    if (args[0] === 'info' && args.at(-1) === '{{json .Runtimes}}') return '{}';
    if (['start', 'run', 'build', 'volume'].includes(args[0])) mutations.push(args);
    return fake.run(args);
  } };
  for (const command of ['start', 'install']) {
    await assert.rejects(subject.runCli([command, '--state-dir', state, '--json'], unavailable), /gVisor.*runsc/);
  }
  assert.deepEqual(mutations, []);
  await subject.runCli(['status', '--state-dir', state, '--json'], unavailable);
  await subject.runCli(['stop', '--state-dir', state, '--json'], unavailable);
  assert.deepEqual(mutations, []);
  assert.equal(await readFile(join(state, 'config.json'), 'utf8'), original);
});

test('start refuses an existing ordinary Docker container while stop and status remain available', async () => {
  const state = await mkdtemp(join(tmpdir(), 'vault-agent-old-runc-'));
  const fake = fakeDocker();
  const deps = { run: fake.run, write: () => {} };
  await subject.runCli(['install', '--state-dir', state, '--json'], deps);
  await subject.runCli(['start', '--state-dir', state, '--json'], deps);
  await subject.runCli(['stop', '--state-dir', state, '--json'], deps);
  const calls = [];
  const oldContainer = { write: () => {}, run: async (args) => {
    calls.push(args);
    const value = await fake.run(args);
    if (args[0] === 'container' && args[1] === 'inspect') {
      const containers = JSON.parse(value);
      containers[0].HostConfig.Runtime = 'runc';
      return JSON.stringify(containers);
    }
    return value;
  } };
  await assert.rejects(subject.runCli(['start', '--state-dir', state, '--json'], oldContainer), /container.*gVisor|container.*runsc/);
  assert.ok(!calls.some((args) => ['run', 'start', 'rm'].includes(args[0])));
  await subject.runCli(['status', '--state-dir', state, '--json'], oldContainer);
  await subject.runCli(['stop', '--state-dir', state, '--json'], oldContainer);
});

test('install/start/status/stop/start persist one owned volume without wiping it', async () => {
  assert.equal(typeof subject.runCli, 'function');
  const state = await mkdtemp(join(tmpdir(), 'vault-agent-cli-'));
  const fake = fakeDocker();
  const output = [];
  const deps = { run: fake.run, write: (line) => output.push(line) };
  const invoke = (cmd) => subject.runCli([cmd, '--state-dir', state, '--json'], deps);
  await invoke('install');
  const original = JSON.parse(await readFile(join(state, 'config.json'), 'utf8'));
  await invoke('start');
  await invoke('status');
  await invoke('stop');
  await invoke('start');
  assert.equal(fake.calls.filter((args) => args[0] === 'run').length, 1);
  assert.equal(fake.calls.filter((args) => args[0] === 'volume' && args[1] === 'create').length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(state, 'config.json'), 'utf8')), original);
  assert.ok(!fake.calls.some((args) => args.includes('rm') || args.includes('prune')));
  assert.doesNotMatch(output.join('\n'), /should-not-print|pair\?code/);
});

test('status without install works and start gives an actionable installation error', async () => {
  assert.equal(typeof subject.runCli, 'function');
  const state = await mkdtemp(join(tmpdir(), 'vault-agent-absent-'));
  const output = [];
  await subject.runCli(['status', '--state-dir', state, '--json'], { write: (line) => output.push(line) });
  assert.equal(JSON.parse(output[0]).installed, false);
  await assert.rejects(subject.runCli(['start', '--state-dir', state]), /install/);
});

test('local device management uses existing bundled CLI with explicit argv and no direct store mutation', async () => {
  const state = await mkdtemp(join(tmpdir(), 'vault-agent-approve-'));
  const fake = fakeDocker();
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  const calls = [];
  const deps = { write: () => {}, run: async (args) => {
    calls.push(args);
    if (args[0] === 'exec') return JSON.stringify({ success: true, result: { approved: true } });
    return fake.run(args);
  } };
  await subject.runCli(['install', '--state-dir', state, '--json'], deps);
  await subject.runCli(['start', '--state-dir', state, '--json'], deps);
  await subject.runCli(['approve', id, '--terminals', '--files', '--state-dir', state, '--json'], deps);
  await subject.runCli(['revoke', id, '--state-dir', state, '--json'], deps);
  await subject.runCli(['devices', '--state-dir', state, '--json'], deps);
  const execs = calls.filter((args) => args[0] === 'exec');
  assert.ok(execs.every((args) => args.includes('ELECTRON_RUN_AS_NODE=1')));
  assert.ok(execs.every((args) => args.includes('/opt/vault/squashfs-root/vault-desktop')));
  assert.ok(execs.some((args) => args.slice(-8).join(' ') === `link approve --device ${id} --terminals --files --pair --json`));
  assert.ok(execs.some((args) => args.slice(-5).join(' ') === `link revoke --device ${id} --json`));
  assert.ok(execs.some((args) => args.slice(-3).join(' ') === 'link devices --json'));
});

test('concurrent installers cannot overwrite ownership configuration', async () => {
  const state = await mkdtemp(join(tmpdir(), 'vault-agent-lock-'));
  const fake = fakeDocker();
  let release;
  let began;
  const building = new Promise((resolve) => { began = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const deps = { write: () => {}, run: async (args) => {
    if (args[0] === 'build') { began(); await gate; }
    return fake.run(args);
  } };
  const first = subject.runCli(['install', '--state-dir', state, '--json'], deps);
  await building;
  try {
    await assert.rejects(subject.runCli(['install', '--state-dir', state, '--json'], { run: fake.run, write: () => {} }), /installation.*progress|locked/);
  } finally { release(); await first; }
  await subject.runCli(['install', '--state-dir', state, '--json'], { run: fake.run, write: () => {} });
});

test('pair refuses revoked startup credentials after consulting the live local runtime', async () => {
  const state = await mkdtemp(join(tmpdir(), 'vault-agent-revoked-'));
  const fake = fakeDocker();
  const deviceId = '01234567-89ab-cdef-0123-456789abcdef';
  const payload = { v: 2, scope: 'runtime', endpoint: 'ws://127.0.0.1:6768', pairedDeviceId: deviceId, deviceToken: 'private-token', publicKeyB64: Buffer.alloc(32, 1).toString('base64') };
  const url = 'vault-desktop://pair?code=' + Buffer.from(JSON.stringify(payload)).toString('base64url');
  const ready = JSON.stringify({ type: 'vault_server_ready', schemaVersion: 1, pairing: { available: true, scope: 'runtime', url, endpoint: payload.endpoint } });
  let revoked = true;
  const output = [];
  const deps = { write: (line) => output.push(line), run: async (args) => {
    if (args[0] === 'exec' && args.includes('cat')) return ready;
    if (args[0] === 'exec') return JSON.stringify({ success: true, result: { devices: [{ deviceId, revoked }] } });
    return fake.run(args);
  } };
  await subject.runCli(['install', '--state-dir', state, '--json'], deps);
  await subject.runCli(['start', '--state-dir', state, '--json'], deps);
  await assert.rejects(subject.runCli(['pair', '--state-dir', state, '--json'], deps), /revoked|current/);
  assert.ok(!output.some((line) => line.includes(url)));
  revoked = false;
  await subject.runCli(['pair', '--state-dir', state, '--json'], deps);
  assert.equal(JSON.parse(output.at(-1)).url, url);
});

test('0.1.1 release version and help agree with its package metadata', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(metadata.version, '0.1.1');
  const version = [];
  await subject.runCli(['--version'], { write: value => version.push(value) });
  assert.deepEqual(version, [metadata.version]);
  assert.match(subject.HELP, /^Vault Cloud Agent 0\.1\.1 /);
});

test('0.1.1 names its built runtime image without upgrading an existing installation', async () => {
  const state = await mkdtemp(join(tmpdir(), 'vault-agent-release-011-'));
  const fake = fakeDocker();
  const calls = [];
  const output = [];
  const deps = { write: value => output.push(value), run: async args => {
    calls.push(args); return fake.run(args);
  } };
  await subject.runCli(['install', '--state-dir', state, '--json'], deps);
  const build = calls.find(args => args[0] === 'build');
  const release = JSON.parse(await readFile(new URL('../assets/runtime-release.json', import.meta.url), 'utf8'));
  assert.equal(build[build.indexOf('--tag') + 1], `vault-cloud-agent-runtime:0.1.1-desktop-${release.version}`);
  const configuration = await readFile(join(state, 'config.json'), 'utf8');
  await subject.runCli(['install', '--state-dir', state, '--json'], deps);
  assert.equal(calls.filter(args => args[0] === 'build').length, 1);
  assert.equal(await readFile(join(state, 'config.json'), 'utf8'), configuration);
});

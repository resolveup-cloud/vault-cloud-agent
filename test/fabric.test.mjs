import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../lib/cli.mjs';
import * as fabric from '../lib/fabric.mjs';

const CODE = 'ABCD-EFGH-JKLM';
const DEVICE = '01234567-89ab-cdef-0123-456789abcdef';
const elf = (extra = 'agent') => Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF' + extra)]);

async function agentFile() {
  const dir = await mkdtemp(join(tmpdir(), 'fabric-agent-bin-'));
  const path = join(dir, 'vault-agent');
  await writeFile(path, elf());
  return path;
}

function fakeDocker({ runtimes = '{"runsc":{"path":"runsc"}}', enrollOutput } = {}) {
  const calls = [];
  const inputs = [];
  let container = null;
  let volume = null;
  return { calls, inputs, get container() { return container; }, run: async (args, opts = {}) => {
    calls.push(args);
    if (opts.input !== undefined) inputs.push(opts.input);
    if (args[0] === 'info') return args.at(-1) === '{{json .Runtimes}}' ? runtimes : 'linux/x86_64';
    if (args[0] === 'build') return '';
    if (args[0] === 'image') return 'sha256:' + 'b'.repeat(64);
    if (args[0] === 'volume') {
      if (args[1] === 'ls') return volume?.Name ?? '';
      if (args[1] === 'create') { volume = { Name: args.at(-1), Labels: { 'dev.vault.cloud-agent.owner': args[3].split('=')[1] } }; return volume.Name; }
      return JSON.stringify([volume]);
    }
    if (args[0] === 'run' && args.includes('--rm')) {
      return enrollOutput ?? `vault-agent: diagnostics\n${JSON.stringify({ deviceId: DEVICE, name: 'box', status: 'offline', server: 'https://fabric.example.com/api/fabric' })}`;
    }
    if (args[0] === 'run') {
      const owner = args[args.indexOf('--label') + 1].split('=')[1];
      const runtime = args.find((x) => x.startsWith('--runtime=')).split('=')[1];
      container = { name: args[args.indexOf('--name') + 1], HostConfig: { Runtime: runtime }, Config: { Labels: { 'dev.vault.cloud-agent.owner': owner } }, State: { Status: 'running', Running: true } };
      return 'container-id';
    }
    if (args[0] === 'container' && args[1] === 'ls') return container?.name ?? '';
    if (args[0] === 'container') return JSON.stringify([container]);
    if (args[0] === 'exec') return JSON.stringify({ deviceId: DEVICE, name: 'box', publicKey: 'pub', deviceToken: 'fdt_secret' });
    if (args[0] === 'stop') { container.State = { Status: 'exited', Running: false }; return ''; }
    if (args[0] === 'start') { container.State = { Status: 'running', Running: true }; return ''; }
    throw new Error(`Unexpected Docker command ${args[0]}`);
  } };
}

test('fabric enroll refuses missing gVisor before building, enrolling or writing state', async () => {
  const state = await mkdtemp(join(tmpdir(), 'fabric-no-runsc-'));
  const fake = fakeDocker({ runtimes: '{"runc":{}}' });
  await assert.rejects(runCli(['fabric', 'enroll', '--server', 'https://fabric.example.com', '--agent-binary', await agentFile(), '--state-dir', state],
    { run: fake.run, write: () => {}, readInput: async () => `${CODE}\n` }), /gVisor/);
  assert.ok(!fake.calls.some((args) => ['build', 'run', 'volume'].includes(args[0])));
  await assert.rejects(access(join(state, 'fabric.json')));
});

test('fabric enroll passes the code on stdin only and records a sandboxed, tagged device', async () => {
  const state = await mkdtemp(join(tmpdir(), 'fabric-enroll-'));
  const fake = fakeDocker();
  const out = [];
  await runCli(['fabric', 'enroll', '--server', 'https://fabric.example.com/api/fabric', '--name', 'box', '--agent-binary', await agentFile(), '--state-dir', state, '--json'],
    { run: fake.run, write: (line) => out.push(line), readInput: async () => `${CODE}\n` });
  assert.ok(!fake.calls.flat().some((arg) => arg.includes(CODE)), 'the enrollment code must never reach Docker argv');
  assert.deepEqual(fake.inputs, [`${CODE}\n`]);
  const enroll = fake.calls.find((args) => args[0] === 'run');
  assert.ok(enroll.includes('--runtime=runsc'));
  assert.ok(enroll.includes('--cap-drop=ALL') && enroll.includes('--read-only') && enroll.includes('--security-opt=no-new-privileges:true'));
  assert.ok(enroll.includes(`VAULT_AGENT_TAGS=${fabric.RUNNER_PROFILE_TAG}`));
  assert.ok(!enroll.includes('VAULT_AGENT_ALLOW_SHELL=1'), 'shell stays off unless --allow-shell');
  assert.deepEqual(enroll.slice(enroll.indexOf('enroll')), ['enroll', '--server', 'https://fabric.example.com', '--name', 'box']);
  const config = JSON.parse(await readFile(join(state, 'fabric.json'), 'utf8'));
  assert.equal(config.deviceId, DEVICE);
  assert.equal(config.agentSha256, createHash('sha256').update(elf()).digest('hex'));
  assert.ok(!JSON.stringify(config).includes(CODE));
  assert.deepEqual(JSON.parse(out.at(-1)), { enrolled: true, deviceId: DEVICE, name: 'box', status: 'offline', tag: fabric.RUNNER_PROFILE_TAG });
  await assert.rejects(runCli(['fabric', 'enroll', '--server', 'https://fabric.example.com', '--agent-binary', await agentFile(), '--state-dir', state],
    { run: fake.run, write: () => {}, readInput: async () => `${CODE}\n` }), /already has an enrolled/);
});

test('fabric enroll rejects codes in unexpected shapes and insecure or ambiguous servers', async () => {
  const state = await mkdtemp(join(tmpdir(), 'fabric-bad-'));
  const base = ['fabric', 'enroll', '--agent-binary', await agentFile(), '--state-dir', state];
  for (const input of ['', 'a b c d', `${CODE}\n${CODE}\n`, 'x'.repeat(65)]) {
    const fake = fakeDocker();
    await assert.rejects(runCli([...base, '--server', 'https://fabric.example.com'], { run: fake.run, write: () => {}, readInput: async () => input }), /enrollment code/);
    assert.equal(fake.calls.length, 0);
  }
  for (const server of ['http://fabric.example.com', 'https://user:pw@fabric.example.com', 'https://fabric.example.com/other', 'https://fabric.example.com/?x=1', 'not a url']) {
    await assert.rejects(runCli([...base, '--server', server], { run: fakeDocker().run, write: () => {}, readInput: async () => CODE }), /--server/);
  }
  assert.throws(() => fabric.parseFabricOptions(['enroll', '--server', 'https://a.example', '--name', '--bad']), /Missing value/);
  assert.throws(() => fabric.parseFabricOptions(['start', '--server', 'https://a.example']), /only accepted by fabric enroll/);
  assert.equal(fabric.fabricServer('http://fabric-cp:8090', { allowInsecureHttp: true }), 'http://fabric-cp:8090');
});

test('runner container is unprivileged, unpublished and mounts no host path', () => {
  const config = { owner: 'o', name: 'vault-cloud-agent-fabric-0123456789ab', volume: 'vault-cloud-agent-fabric-0123456789ab-data', image: 'sha256:' + 'c'.repeat(64), server: 'https://f.example', deviceName: 'box', allowShell: true };
  const args = fabric.runnerArgs(config);
  for (const flag of ['--runtime=runsc', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=512', '--read-only', '--restart=unless-stopped', '1000:1000']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.ok(args.includes('type=volume,src=vault-cloud-agent-fabric-0123456789ab-data,dst=/home/vault'));
  assert.ok(args.includes('VAULT_AGENT_ALLOW_SHELL=1'));
  assert.ok(!args.some((x) => /type=bind|docker\.sock|--privileged|--publish|^-p$|unconfined|--network=host/.test(x)));
  assert.deepEqual(args.slice(-2), [config.image, 'run']);
  assert.ok(fabric.runnerArgs(config, { runtime: 'runc' }).includes(`VAULT_AGENT_TAGS=${fabric.UNSANDBOXED_TAG}`));
  assert.ok(fabric.enrollArgs({ ...config, server: 'http://fabric-cp:8090' }).includes('--dev'));
});

test('downloaded vault-agent must match the control plane SHA256SUMS', async () => {
  const good = elf();
  const sum = createHash('sha256').update(good).digest('hex');
  const serve = (files) => async (url) => {
    const name = url.split('/').pop();
    return name in files ? { ok: true, arrayBuffer: async () => files[name] } : { ok: false };
  };
  const agent = await fabric.obtainAgent({}, 'https://f.example', serve({ SHA256SUMS: Buffer.from(`${sum}  vault-agent-linux-amd64\n`), 'vault-agent-linux-amd64': good }));
  assert.equal(agent.sha256, sum);
  await assert.rejects(fabric.obtainAgent({}, 'https://f.example', serve({ SHA256SUMS: Buffer.from(`${'0'.repeat(64)}  vault-agent-linux-amd64\n`), 'vault-agent-linux-amd64': good })), /does not match/);
  await assert.rejects(fabric.obtainAgent({}, 'https://f.example', serve({ SHA256SUMS: Buffer.from('') })), /does not list/);
  await assert.rejects(fabric.obtainAgent({}, 'https://f.example', serve({ SHA256SUMS: Buffer.from(`${sum}  vault-agent-linux-amd64\n`), 'vault-agent-linux-amd64': Buffer.from('#!/bin/sh') })), /Linux executable/);
});

test('fabric start/stop/status manage only the owned runner and never print credentials', async () => {
  const state = await mkdtemp(join(tmpdir(), 'fabric-lifecycle-'));
  const fake = fakeDocker();
  const deps = { run: fake.run, write: () => {}, readInput: async () => CODE };
  await runCli(['fabric', 'status', '--state-dir', state, '--json'], { ...deps, write: (line) => assert.deepEqual(JSON.parse(line), { enrolled: false }) });
  await assert.rejects(runCli(['fabric', 'start', '--state-dir', state], deps), /fabric enroll first/);
  await runCli(['fabric', 'enroll', '--server', 'https://fabric.example.com', '--agent-binary', await agentFile(), '--state-dir', state], deps);
  await runCli(['fabric', 'start', '--state-dir', state], deps);
  assert.equal(fake.container.HostConfig.Runtime, 'runsc');
  const out = [];
  await runCli(['fabric', 'status', '--state-dir', state, '--json'], { ...deps, write: (line) => out.push(line) });
  const status = JSON.parse(out[0]);
  assert.equal(status.status, 'running');
  assert.equal(status.agent.deviceId, DEVICE);
  assert.ok(!out[0].includes('fdt_secret'));
  await runCli(['fabric', 'stop', '--state-dir', state], deps);
  assert.equal(fake.container.State.Running, false);
  fake.container.HostConfig.Runtime = 'runc';
  await assert.rejects(runCli(['fabric', 'start', '--state-dir', state], deps), /expected runtime/);
  fake.container.Config.Labels['dev.vault.cloud-agent.owner'] = 'someone-else';
  await assert.rejects(runCli(['fabric', 'stop', '--state-dir', state], deps), /not owned/);
});

test('fabric commands leave the Desktop runtime configuration untouched', async () => {
  const state = await mkdtemp(join(tmpdir(), 'fabric-separate-'));
  const fake = fakeDocker();
  await runCli(['fabric', 'enroll', '--server', 'https://fabric.example.com', '--agent-binary', await agentFile(), '--state-dir', state],
    { run: fake.run, write: () => {}, readInput: async () => CODE });
  await assert.rejects(access(join(state, 'config.json')));
  const status = [];
  await runCli(['status', '--state-dir', state, '--json'], { run: fake.run, write: (line) => status.push(line) });
  assert.deepEqual(JSON.parse(status[0]), { installed: false });
});

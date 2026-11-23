// End-to-end check of the Fabric runner profile against a real, disposable control plane.
// Skipped unless VAULT_CLOUD_AGENT_FABRIC_E2E_CHECKOUT (a vault-fabric checkout with
// dependencies installed) and VAULT_CLOUD_AGENT_FABRIC_E2E_AGENT (a linux/amd64 vault-agent
// build) are set. Everything it creates (network, Postgres, control plane, runner, volume, image)
// carries VAULT_CLOUD_AGENT_FABRIC_E2E_SUFFIX and is removed at the end. Published ports bind
// to 127.0.0.1 only.
//
// The runner runs with the default Docker runtime unless VAULT_CLOUD_AGENT_FABRIC_E2E_RUNTIME=runsc:
// without gVisor installed this proves the Fabric protocol inside the container, not gVisor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runCli } from '../lib/cli.mjs';
import { runnerTag } from '../lib/fabric.mjs';

const exec = promisify(execFile);
const checkout = process.env.VAULT_CLOUD_AGENT_FABRIC_E2E_CHECKOUT;
const agentBinary = process.env.VAULT_CLOUD_AGENT_FABRIC_E2E_AGENT;
const suffix = process.env.VAULT_CLOUD_AGENT_FABRIC_E2E_SUFFIX ?? 'e2e';
const runtime = process.env.VAULT_CLOUD_AGENT_FABRIC_E2E_RUNTIME ?? 'runc';
const port = Number(process.env.VAULT_CLOUD_AGENT_FABRIC_E2E_PORT ?? 18790);
const skip = !(checkout && agentBinary) && 'set VAULT_CLOUD_AGENT_FABRIC_E2E_CHECKOUT and VAULT_CLOUD_AGENT_FABRIC_E2E_AGENT';

const names = { net: `vca-fabric-net-${suffix}`, pg: `vca-fabric-pg-${suffix}`, cp: `vca-fabric-cp-${suffix}` };
const TOKEN = `e2e-user-token-${suffix}`;
const API = `http://127.0.0.1:${port}/api/fabric`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = async (...args) => (await exec('docker', args, { encoding: 'utf8', maxBuffer: 8 << 20 })).stdout.trim();
const quiet = (...args) => sh(...args).catch(() => '');
// The runner image has no ps; count processes whose argv is exactly `sleep <n>` from /proc.
const sleepers = (runner, seconds) => quiet('exec', runner, 'sh', '-c',
  `n=0; for f in /proc/[0-9]*/cmdline; do [ "$(tr '\\0' ' ' < "$f" 2>/dev/null)" = "sleep ${seconds} " ] && n=$((n+1)); done; echo $n`);

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function waitFor(label, probe, timeoutMs = 90_000, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await probe(); if (last) return last; } catch (error) { last = error; }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

const job = async (id) => (await api('GET', `/jobs/${id}`)).body;
const waitStatus = (id, statuses, timeoutMs) => waitFor(`job ${id} in ${statuses}`, async () => {
  const detail = await job(id);
  return statuses.includes(detail.job.status) ? detail : null;
}, timeoutMs);

test('Fabric runner profile: enroll, claim, run in the container, renew, cancel and recover', { skip, timeout: 600_000 }, async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'vca-fabric-e2e-'));
  const deps = { runtime, network: names.net, allowInsecureHttp: true, write: () => {} };
  let runner;
  t.after(async () => {
    const config = JSON.parse(await readFile(join(state, 'fabric.json'), 'utf8').catch(() => '{}'));
    if (config.name) { await quiet('rm', '-f', config.name, `${config.name}-enroll`); await quiet('volume', 'rm', '-f', config.volume); }
    if (config.image) await quiet('image', 'rm', '-f', config.image);
    await quiet('rm', '-f', names.cp, names.pg);
    await quiet('network', 'rm', names.net);
    await rm(state, { recursive: true, force: true });
  });

  await sh('network', 'create', '--label', `vca-fabric-e2e=${suffix}`, names.net);
  await sh('run', '-d', '--name', names.pg, '--network', names.net, '-e', 'POSTGRES_PASSWORD=fabric', 'postgres:16-alpine');
  await waitFor('postgres', async () => (await quiet('exec', names.pg, 'pg_isready', '-U', 'postgres')).includes('accepting'));
  const env = {
    NODE_ENV: 'development', PORT: '8090', DATABASE_URL: `postgres://postgres:fabric@${names.pg}:5432/postgres`,
    FABRIC_MIGRATE_ON_START: 'true', FABRIC_AUTH_MODE: 'static', FABRIC_STATIC_USERS: JSON.stringify({ [TOKEN]: `org-${suffix}:user-${suffix}` }),
    FABRIC_STORAGE_DIR: '/tmp/fabric-objects', FABRIC_LEASE_TTL_MS: '8000', FABRIC_LEASE_RENEW_MS: '2000', FABRIC_SWEEPER_INTERVAL_MS: '1000',
    FABRIC_PUBLIC_URL: `http://${names.cp}:8090/api/fabric`,
  };
  await sh('run', '-d', '--name', names.cp, '--network', names.net, '--publish', `127.0.0.1:${port}:8090`,
    '--mount', `type=bind,src=${checkout},dst=${checkout},readonly`, '--workdir', join(checkout, 'services/control-plane'),
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), 'oven/bun:1.3.14', 'bun', 'run', 'src/server.ts');
  await waitFor('control plane', async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 120_000);

  // Enrollment: single-use code from the user, passed on stdin; the device carries the runner tag.
  const { body: { code } } = await api('POST', '/enrollment-codes', {});
  assert.ok(code);
  await runCli(['fabric', 'enroll', '--server', `http://${names.cp}:8090`, '--name', `runner-${suffix}`, '--agent-binary', agentBinary,
    '--allow-shell', '--state-dir', state, '--json'], { ...deps, readInput: async () => `${code}\n` });
  const config = JSON.parse(await readFile(join(state, 'fabric.json'), 'utf8'));
  runner = config.name;
  assert.ok(!JSON.stringify(config).includes(code), 'the code is not persisted');
  await runCli(['fabric', 'start', '--state-dir', state], deps);
  const tag = runnerTag(runtime);
  const device = await waitFor('device online with runner tag', async () => {
    const { body } = await api('GET', `/devices/${config.deviceId}`);
    const d = body.device;
    return d.status === 'online' && d.capabilities?.tags?.includes(tag) && d.capabilities.executors.includes('shell') ? d : null;
  });
  assert.equal(device.name, `runner-${suffix}`);
  const inspect = JSON.parse(await sh('container', 'inspect', runner))[0];
  assert.equal(inspect.HostConfig.Runtime, runtime);
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']);
  assert.ok(!inspect.Mounts.some((m) => m.Type === 'bind'), 'no host path is mounted into the runner');

  const { body: { workspace } } = await api('POST', '/workspaces', { name: `e2e-${suffix}` });
  const create = async (objective, command) => {
    const r = await api('POST', '/jobs', { workspaceId: workspace.id, objective, type: 'shell', requirements: { command, tags: [tag], cloudAllowed: false } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.job.id;
  };

  // Claim + run inside the container: the job sees the container's user, hostname and environment.
  const trivial = await create('trivial job', 'printf "uid=%s host=%s home=%s host-env=%s" "$(id -u)" "$(hostname)" "$HOME" "${DATABASE_URL:-none}"');
  const done = await waitStatus(trivial, ['COMPLETED', 'FAILED'], 90_000);
  assert.equal(done.job.status, 'COMPLETED', JSON.stringify(done.job.error));
  assert.equal(done.job.assignedDeviceId, config.deviceId);
  assert.equal(String(done.job.result.output).trim(), `uid=1000 host=${inspect.Config.Hostname} home=/home/vault host-env=none`);

  // Lease renewal: a job three times longer than the 8 s lease completes on its first attempt.
  const long = await create('longer than the lease', 'sleep 24; echo renewed');
  await waitStatus(long, ['RUNNING'], 60_000);
  const firstRenewal = (await job(long)).lease.renewedAt;
  await waitFor('lease renewed', async () => (await job(long)).lease?.renewedAt > firstRenewal, 20_000);
  const renewed = await waitStatus(long, ['COMPLETED', 'FAILED', 'RECOVERING', 'QUEUED'], 90_000);
  assert.equal(renewed.job.status, 'COMPLETED');
  assert.equal(renewed.job.attempt, 1);
  assert.ok(!renewed.events.some((e) => e.type === 'status' && e.data.to === 'RECOVERING'));

  // Cancellation: the control plane flag stops the process inside the sandbox.
  const cancel = await create('to be canceled', 'sleep 311');
  await waitStatus(cancel, ['RUNNING'], 60_000);
  await waitFor('sleep running in runner', async () => (await sleepers(runner, 311)) === '1', 20_000);
  assert.equal((await api('POST', `/jobs/${cancel}/cancel`, {})).status, 200);
  const canceled = await waitStatus(cancel, ['CANCELED', 'FAILED', 'COMPLETED'], 60_000);
  assert.equal(canceled.job.status, 'CANCELED');
  await waitFor('canceled process gone', async () => (await sleepers(runner, 311)) === '0', 20_000);

  // Recovery: kill the whole runner container mid-job; the lease expires, the job is requeued
  // with attempt 2 and completes after the runner is started again.
  const recover = await create('survives a killed runner', 'sleep 12; echo recovered-ok');
  await waitStatus(recover, ['RUNNING'], 60_000);
  await sh('kill', runner);
  const requeued = await waitFor('job recovering after kill', async () => {
    const d = await job(recover);
    return d.events.some((e) => e.type === 'status' && e.data.to === 'RECOVERING') ? d : null;
  }, 60_000);
  assert.ok(requeued);
  const live = JSON.parse(await sh('container', 'inspect', runner))[0];
  if (!live.State.Running) await runCli(['fabric', 'start', '--state-dir', state], deps);
  const recovered = await waitStatus(recover, ['COMPLETED', 'FAILED'], 120_000);
  assert.equal(recovered.job.status, 'COMPLETED');
  assert.ok(recovered.job.attempt >= 2, `attempt ${recovered.job.attempt}`);
  assert.equal(String(recovered.job.result.output).trim(), 'recovered-ok');

  const status = [];
  await runCli(['fabric', 'status', '--state-dir', state, '--json'], { ...deps, write: (line) => status.push(line) });
  assert.equal(JSON.parse(status[0]).status, 'running');
  assert.ok(!status[0].includes('fdt_'));
  await runCli(['fabric', 'stop', '--state-dir', state], deps);
});

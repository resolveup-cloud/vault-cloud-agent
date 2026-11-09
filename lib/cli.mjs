import { fileURLToPath } from 'node:url';
import { createConfig, loadConfig, parseOptions, saveConfig } from './config.mjs';
import { deviceApproved, docker, endpointHost, gitProtectedMounts, inspectContainer, OWNER_LABEL, privateOutput, readPairing, requireGvisor } from './docker.mjs';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localProjects } from './projects.mjs';

export const HELP = `Vault Cloud Agent 0.2.0 — run Vault on your own machine with Docker

  vault-cloud-agent install [--bind <private-IP>] [--port <port>]
                           [--project <directory>] [--writable-project <directory>]
  vault-cloud-agent start
  vault-cloud-agent status
  vault-cloud-agent pair [--new]
  vault-cloud-agent stop
  vault-cloud-agent projects
  vault-cloud-agent devices
  vault-cloud-agent approve <device-ID> [--terminals] [--files] [--git]
  vault-cloud-agent revoke <device-ID>

All commands accept --state-dir <directory> and --json.
Ingress defaults to 127.0.0.1:6768; use an SSH tunnel or a private VPN.
Requires a Linux x64 Docker daemon with the gVisor runsc runtime registered.
Projects are read-only unless passed with --writable-project. Stop preserves data.
Pair prints a one-time credential that expires in 10 minutes: show it only to the
computer you intend to trust. pair --new withdraws an unused offer and restarts the
runtime to mint a fresh one (running terminals and agents are stopped).
Approving terminals and files together also enables sharing and execution in Pair.
`;

export const OFFER_TTL_MS = 10 * 60 * 1000;
const WRITABLE_WARNING = 'Warning: --writable-project lets Vault agents and approved devices change files that\n' +
  'you may later build, test or run on this host. Its .git/hooks and .git/config are mounted\n' +
  'read-only in the container; review changes before running them on the host.';

// Offers shown by `pair`, keyed by device ID. No credential is stored, only when it was shown.
async function loadOffers(stateDir) {
  try {
    const value = JSON.parse(await readFile(join(stateDir, 'pairing-offers.json'), 'utf8'));
    if (value && typeof value.offers === 'object' && !Array.isArray(value.offers)) return value;
  } catch { /* Missing or unreadable: treat as no offers shown; never as permission to re-show. */ }
  return { offers: {} };
}

async function saveOffers(stateDir, value) {
  const temporary = join(stateDir, `.pairing-offers-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(stateDir, 'pairing-offers.json'));
}

async function revokeDevice(config, deviceId, run) {
  await localLink(config, ['revoke', '--device', deviceId], run);
}

/**
 * Why: a startup offer carries a long-lived device bearer token. Showing it repeatedly turned it
 * into a standing credential for anyone able to run this command, so offers are one-time and
 * expire; an expired offer that was never approved is revoked in the runtime.
 */
async function sweepExpiredOffers(config, state, devices, now, run) {
  let changed = false;
  for (const [deviceId, offer] of Object.entries(state.offers)) {
    if (offer.settled || now - offer.shownAt <= OFFER_TTL_MS) continue;
    const device = devices.find((entry) => entry.deviceId === deviceId);
    if (device && !device.revoked && !deviceApproved(device)) await revokeDevice(config, deviceId, run);
    offer.settled = true;
    changed = true;
  }
  return changed;
}

async function pair(options, config, run, now, emit) {
  const state = await loadOffers(options.stateDir);
  const registry = await localLink(config, ['devices'], run);
  const devices = Array.isArray(registry?.result?.devices) ? registry.result.devices : null;
  if (!devices) throw new Error('Cannot read the local device registry.');
  let changed = await sweepExpiredOffers(config, state, devices, now, run);
  const output = await run(['exec', '--user', 'vault', config.name, 'cat', privateOutput]);
  const result = readPairing(output, config);
  const device = devices.find((entry) => entry.deviceId === result.deviceId);
  const shown = state.offers[result.deviceId];
  if (options.renew) {
    if (device && !device.revoked && !deviceApproved(device)) await revokeDevice(config, result.deviceId, run);
    state.offers[result.deviceId] = { shownAt: shown?.shownAt ?? now, settled: true };
    await saveOffers(options.stateDir, state);
    await run(['restart', '--time', '30', config.name]);
    emit({ renewed: true }, 'Previous offer withdrawn and the runtime restarted. Wait for healthy status, then run vault-cloud-agent pair.');
    return;
  }
  if (changed) await saveOffers(options.stateDir, state);
  if (!device || device.revoked === true) {
    throw new Error('Startup pairing credential is revoked or no longer current. Run vault-cloud-agent pair --new to create a new offer.');
  }
  if (deviceApproved(device)) {
    throw new Error('This offer was already used: its device is paired and approved. Run vault-cloud-agent pair --new to pair another computer.');
  }
  if (shown) {
    throw new Error(now - shown.shownAt > OFFER_TTL_MS
      ? 'This pairing offer expired. Run vault-cloud-agent pair --new to create a new one.'
      : 'This pairing offer was already shown once. Run vault-cloud-agent pair --new to withdraw it and create a new one.');
  }
  state.offers[result.deviceId] = { shownAt: now };
  await saveOffers(options.stateDir, state);
  const expiresAt = now + OFFER_TTL_MS;
  emit({ ...result, expiresAt }, `Open this pairing link on your trusted computer within 10 minutes:\n${result.url}\n` +
    'It is shown only once. Keep it private. After pairing, approve the device with vault-cloud-agent approve; ' +
    'an offer left unapproved after 10 minutes is revoked the next time you run pair or devices.');
}

async function ensureVolume(config, run) {
  const names = await run(['volume', 'ls', '--filter', `name=^${config.volume}$`, '--format', '{{.Name}}']);
  if (!names.split('\n').includes(config.volume)) {
    await run(['volume', 'create', '--label', `${OWNER_LABEL}=${config.owner}`, config.volume]);
    return;
  }
  const volume = JSON.parse(await run(['volume', 'inspect', config.volume]))[0];
  if (volume?.Labels?.[OWNER_LABEL] !== config.owner) {
    throw new Error('Persistent volume is not owned by this configuration; refusing to reuse it.');
  }
}

async function install(options, config, run) {
  if (config && (options.projects.length || options.bind !== '127.0.0.1' || options.port !== 6768)) {
    throw new Error('Already configured. Preserve the configuration and data volume; use a separate --state-dir for another agent.');
  }
  await requireGvisor(run);
  if (config?.image) return { installed: true, container: config.name, runtimeVersion: config.runtimeVersion, volume: config.volume };
  const platform = await run(['info', '--format', '{{.OSType}}/{{.Architecture}}']);
  if (!/^linux\/(x86_64|amd64)$/.test(platform)) throw new Error('Cloud Agent currently requires a Linux x64 Docker daemon.');
  const release = JSON.parse(await readFile(new URL('../assets/runtime-release.json', import.meta.url), 'utf8'));
  const tag = `vault-cloud-agent-runtime:0.2.0-desktop-${release.version}`;
  const next = config ?? await createConfig(options);
  await saveConfig(options.stateDir, next);
  await run(['build', '--platform=linux/amd64', '--tag', tag,
    '--build-arg', `VAULT_VERSION=${release.version}`, '--build-arg', `VAULT_SHA256=${release.sha256}`,
    '--build-arg', `VAULT_DOWNLOAD_URL=${release.url}`,
    fileURLToPath(new URL('../assets/', import.meta.url))], { stream: !options.json });
  const image = await run(['image', 'inspect', '--format', '{{.Id}}', tag]);
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Docker did not return a valid built image identity.');
  next.image = image;
  next.runtimeVersion = release.version;
  await ensureVolume(next, run);
  await saveConfig(options.stateDir, next);
  return { installed: true, container: next.name, runtimeVersion: next.runtimeVersion, volume: next.volume };
}

async function localLink(config, args, run) {
  const response = await run(['exec', '--user', 'vault', '--env', 'ELECTRON_RUN_AS_NODE=1',
    config.name, '/opt/vault/squashfs-root/vault-desktop',
    '/opt/vault/squashfs-root/resources/app.asar.unpacked/out/cli/index.js', 'link', ...args, '--json']);
  let result;
  try { result = JSON.parse(response); } catch { throw new Error('Local device administration requires Vault runtime 0.11.4 or newer.'); }
  if (result?.success === false || result?.ok === false || result?.error) {
    throw new Error('Local device command was refused. Check the device ID and runtime 0.11.4 support.');
  }
  return result;
}

export async function runCli(argv, dependencies = {}) {
  const options = parseOptions(argv);
  if (options.command !== 'install') return dispatch(options, dependencies);
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await chmod(options.stateDir, 0o700);
  const lockPath = join(options.stateDir, 'install.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another installation is in progress (state locked). If it crashed, remove install.lock only after verifying that installer has stopped.');
    throw new Error('Cannot lock installation state.');
  }
  try {
    await lock.writeFile(String(process.pid));
    return await dispatch(options, dependencies);
  } finally { await lock.close(); await unlink(lockPath); }
}

async function dispatch(options, { run = docker, write = (line) => console.log(line), now = Date.now } = {}) {
  if (['help', '--help'].includes(options.command)) { write(HELP); return; }
  if (options.command === '--version') { write('0.2.0'); return; }
  const config = await loadConfig(options.stateDir);
  const emit = (value, message) => write(options.json ? JSON.stringify(value) : message);
  if (options.command === 'install') {
    const result = await install(options, config, run);
    const writable = options.projects.some((project) => !project.readOnly);
    emit(writable ? { ...result, warnings: [WRITABLE_WARNING] } : result,
      `${writable ? `${WRITABLE_WARNING}\n` : ''}Cloud Agent installed. Run vault-cloud-agent start, then vault-cloud-agent pair.`);
    return;
  }
  if (!config) {
    if (options.command === 'status') { emit({ installed: false }, 'Cloud Agent is not installed.'); return; }
    throw new Error('Run vault-cloud-agent install first.');
  }
  const container = await inspectContainer(config, run);
  if (options.command === 'status') {
    const result = { installed: Boolean(config.image), container: config.name, status: container?.State?.Status ?? 'not-created',
      health: container?.State?.Health?.Status ?? null, endpoint: `ws://${endpointHost(config.bind)}:${config.port}`,
      runtimeVersion: config.runtimeVersion, volume: config.volume, projects: config.projects };
    emit(result, `Cloud Agent: ${result.status}; health: ${result.health ?? 'unknown'}; ${result.endpoint}`);
    return;
  }
  if (options.command === 'stop') {
    if (container?.State?.Running) await run(['stop', '--time', '30', config.name]);
    emit({ stopped: true, volume: config.volume }, 'Cloud Agent stopped. Persistent data and project files were retained.');
    return;
  }
  if (options.command === 'start') {
    if (!config.image) throw new Error('Installation is incomplete. Run vault-cloud-agent install again.');
    await requireGvisor(run);
    if (container && container.HostConfig?.Runtime !== 'runsc') {
      throw new Error('Existing Cloud Agent container does not use gVisor runsc. Preserve its data volume and migrate the container before starting.');
    }
    if (!container) {
      await ensureVolume(config, run);
      const { runArgs } = await import('./docker.mjs');
      await run(runArgs(config, await gitProtectedMounts(config.projects)));
    } else if (!container.State?.Running) await run(['start', config.name]);
    emit({ started: true, container: config.name }, 'Cloud Agent started. Check status for health, then run vault-cloud-agent pair.');
    return;
  }
  if (!container?.State?.Running) throw new Error('Cloud Agent is stopped. Run vault-cloud-agent start first.');
  if (options.command === 'projects') {
    const result = await localProjects(config, run);
    write(JSON.stringify(result, null, options.json ? undefined : 2));
    return;
  }
  if (['devices', 'approve', 'revoke'].includes(options.command)) {
    if (options.command === 'devices') {
      const state = await loadOffers(options.stateDir);
      const listed = (await localLink(config, ['devices'], run))?.result?.devices;
      if (Array.isArray(listed) && await sweepExpiredOffers(config, state, listed, now(), run)) await saveOffers(options.stateDir, state);
    }
    const args = [options.command];
    if (options.deviceId) args.push('--device', options.deviceId);
    args.push(...options.grants);
    if (options.command === 'approve' && options.grants.includes('--terminals') && options.grants.includes('--files')) args.push('--pair');
    const result = await localLink(config, args, run);
    // The supported runtime command should already redact credentials. Defense in depth
    // keeps unexpected older output from publishing tokens in status/device listings.
    const sanitized = JSON.parse(JSON.stringify(result, (key, value) =>
      /token|secret|password|pairing.?url|private.?key/i.test(key) ? undefined : value));
    write(JSON.stringify(sanitized, null, options.json ? undefined : 2));
    return;
  }
  await pair(options, config, run, now(), emit);
}

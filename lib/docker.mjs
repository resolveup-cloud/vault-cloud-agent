import { execFile, spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const OWNER_LABEL = 'dev.vault.cloud-agent.owner';
export const privateOutput = '/tmp/vault-cloud-agent-runtime-output';

export function endpointHost(bind) { return bind.includes(':') ? `[${bind}]` : bind; }

export async function requireGvisor(run = docker) {
  const value = await run(['info', '--format', '{{json .Runtimes}}']);
  let runtimes;
  try { runtimes = JSON.parse(value); } catch { /* Refuse incomplete runtime evidence. */ }
  if (!runtimes || Array.isArray(runtimes) || !Object.hasOwn(runtimes, 'runsc') ||
      !runtimes.runsc || typeof runtimes.runsc !== 'object' || Array.isArray(runtimes.runsc)) {
    throw new Error('Cloud Agent requires gVisor registered as Docker runtime runsc. Install and configure it before continuing: https://gvisor.dev/docs/user_guide/quick_start/docker/');
  }
}

// Git runs these on the HOST whenever the owner uses the repository there: hooks directly, and
// .git/config through core.hooksPath, core.fsmonitor, filter drivers or sshCommand. A writable
// project must not let container code plant them, so they are layered back read-only.
const GIT_PROTECTED = [['.git/hooks', 'directory'], ['.git/config', 'file']];

/** Read-only overlay mounts for the git control paths of writable projects (existing ones only). */
export async function gitProtectedMounts(projects) {
  const mounts = [];
  for (const project of projects) {
    if (project.readOnly) continue;
    for (const [relative, kind] of GIT_PROTECTED) {
      const source = join(project.source, relative);
      let info;
      try { info = await lstat(source); } catch { continue; }
      // Symlinks are refused: the overlay must cover the path git actually reads in the project.
      if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) continue;
      if (/[,\x00-\x1f\x7f]/.test(source)) continue;
      mounts.push({ source, target: `${project.target}/${relative}` });
    }
  }
  return mounts;
}

export function runArgs(config, protectedMounts = []) {
  const endpoint = `${endpointHost(config.bind)}:${config.port}`;
  const args = ['run', '--detach', '--name', config.name, '--label', `${OWNER_LABEL}=${config.owner}`,
    '--runtime=runsc', '--restart=unless-stopped', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=512',
    '--stop-timeout=30', '--publish', `${endpoint}:6768`, '--env', `VAULT_PAIRING_ADDRESS=${endpoint}`,
    '--mount', `type=volume,src=${config.volume},dst=/home/vault`];
  for (const project of config.projects) {
    args.push('--mount', `type=bind,src=${project.source},dst=${project.target}${project.readOnly ? ',readonly' : ''}`);
  }
  // Docker orders mounts by destination depth, so these nested read-only binds sit on top.
  for (const mount of protectedMounts) {
    args.push('--mount', `type=bind,src=${mount.source},dst=${mount.target},readonly`);
  }
  args.push(config.image);
  return args;
}

export async function docker(args, { stream = false } = {}) {
  if (stream) {
    await new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'inherit', 'inherit'], shell: false });
      child.on('error', () => reject(new Error('Docker is unavailable. Install Docker and start its daemon.')));
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Docker build failed. Configuration and persistent data were retained.')));
    });
    return '';
  }
  try {
    return (await execute('docker', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    // Docker errors can include argv or runtime output. Do not echo either.
    if (error.code === 'ENOENT') throw new Error('Docker is unavailable. Install Docker and start its daemon.');
    throw new Error('Docker command failed. Check the daemon and container state; data has not been removed.');
  }
}

export async function inspectContainer(config, run = docker) {
  const names = await run(['container', 'ls', '--all', '--filter', `name=^/${config.name}$`, '--format', '{{.Names}}']);
  if (!names.split('\n').includes(config.name)) return null;
  const result = JSON.parse(await run(['container', 'inspect', config.name]));
  const container = result[0];
  verifyOwnership(container, config);
  return container;
}

export function verifyOwnership(container, config) {
  if (container?.Config?.Labels?.[OWNER_LABEL] !== config.owner) {
    throw new Error('Container is not owned by this Cloud Agent configuration; refusing to change it.');
  }
}

export function readPairing(output, config) {
  let ready;
  for (const line of output.split('\n')) {
    try {
      const candidate = JSON.parse(line);
      if (candidate.type === 'vault_server_ready' && candidate.schemaVersion === 1) ready = candidate;
    } catch { /* Normal runtime diagnostics are deliberately ignored. */ }
  }
  if (!ready) throw new Error('Runtime is not ready. Wait for startup, then run pair again.');
  if (ready.pairing?.available !== true) throw new Error('Runtime pairing is unavailable. Check the private runtime diagnostics.');
  if (ready.pairing.scope !== 'runtime') throw new Error('Expected a runtime pairing offer.');
  let payload;
  try {
    const url = new URL(ready.pairing.url);
    const code = url.searchParams.get('code');
    if (url.protocol !== 'vault-desktop:' || url.hostname !== 'pair' ||
        (url.pathname && url.pathname !== '/') || !code || code.length > 16384 || !/^[\w-]+$/.test(code)) throw new Error();
    payload = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
  } catch { throw new Error('Invalid runtime pairing offer.'); }
  if (!payload || payload.v !== 2 || payload.scope !== 'runtime' || typeof payload.deviceToken !== 'string' ||
      !payload.deviceToken || payload.deviceToken.length > 4096 ||
      typeof payload.publicKeyB64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(payload.publicKeyB64) ||
      Buffer.from(payload.publicKeyB64, 'base64').length !== 32 ||
      Buffer.from(payload.publicKeyB64, 'base64').toString('base64') !== payload.publicKeyB64 ||
      typeof payload.pairedDeviceId !== 'string' || !payload.pairedDeviceId || payload.pairedDeviceId.length > 128) {
    throw new Error('Invalid runtime encryption key or authentication credential.');
  }
  if (payload.relay) throw new Error('A direct runtime offer cannot use a relay invite.');
  if (payload.expiresAt !== undefined && (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now())) {
    throw new Error('Pairing offer expired. Run vault-cloud-agent pair --new to create a new offer.');
  }
  const expected = config ? `ws://${endpointHost(config.bind)}:${config.port}` : ready.pairing.endpoint;
  if (payload.endpoint !== expected || ready.pairing.endpoint !== expected) {
    throw new Error('Pairing endpoint does not match the configured private published address.');
  }
  return { url: ready.pairing.url, endpoint: ready.pairing.endpoint, deviceId: payload.pairedDeviceId };
}

/** A device the owner approved for anything has completed pairing: its startup offer is spent. */
export function deviceApproved(device) {
  const policy = device?.policy;
  return Boolean(policy && ['bypassAll', 'terminal', 'files', 'git', 'browser', 'orchestra', 'computer']
    .some((key) => policy[key] === true));
}

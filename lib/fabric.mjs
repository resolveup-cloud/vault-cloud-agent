// Fabric runner profile: an opt-in, separate container that enrolls as a Vault Fabric device and
// runs Fabric jobs inside the gVisor sandbox. It shares nothing with the Desktop runtime container
// (own owner, volume and image) and mounts no host project: jobs run in Fabric job worktrees that
// vault-agent materializes inside the container's data volume.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStateDir } from './config.mjs';
import { docker, inspectContainer, OWNER_LABEL, requireGvisor } from './docker.mjs';

export const FABRIC_HELP = `Vault Fabric runner profile (opt-in; the Desktop runtime is not affected)

  vault-cloud-agent fabric enroll --server <https URL> [--name <device name>]
                                  [--agent-binary <file>] [--allow-shell]  < code
  vault-cloud-agent fabric start
  vault-cloud-agent fabric status
  vault-cloud-agent fabric stop

enroll reads a single-use Fabric enrollment code from stdin (never from argv), builds
a separate runner image with a checksum-verified vault-agent and registers it as a
Fabric device. Jobs then run inside that container under gVisor runsc, unprivileged,
with no host project mounted and no host environment. --allow-shell additionally lets
jobs run requirements.command inside the sandbox. All commands accept --state-dir
<directory> and --json.
`;

export const RUNNER_PROFILE_TAG = 'vault-runner:gvisor-docker';
/** Only an injected non-gVisor runtime (tests) gets this tag; the CLI itself never offers one. */
export const UNSANDBOXED_TAG = 'vault-runner:docker';
const MAX_AGENT_BYTES = 128 * 1024 * 1024;
const AGENT_FILE = 'vault-agent-linux-amd64';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const CODE_RE = /^[A-Za-z0-9-]{4,64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function parseFabricOptions(argv) {
  const command = argv[0] ?? 'help';
  if (!['enroll', 'start', 'stop', 'status', 'help', '--help'].includes(command)) {
    throw new Error('Unknown fabric command. Use vault-cloud-agent fabric help.');
  }
  const options = { command, stateDir: defaultStateDir(), name: 'vault-cloud-agent', allowShell: false };
  const values = new Set(['--state-dir', '--server', '--name', '--agent-binary']);
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') { options.json = true; continue; }
    if (flag === '--allow-shell' && command === 'enroll') { options.allowShell = true; continue; }
    if (!values.has(flag)) throw new Error(`Unknown flag ${flag}.`);
    if (flag !== '--state-dir' && command !== 'enroll') throw new Error(`${flag} is only accepted by fabric enroll.`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--state-dir') options.stateDir = resolve(value);
    if (flag === '--server') options.server = value;
    if (flag === '--name') options.name = value;
    if (flag === '--agent-binary') options.agentBinary = resolve(value);
  }
  if (command === 'enroll') {
    if (!options.server) throw new Error('--server is required (the Vault Fabric control plane URL).');
    if (!NAME_RE.test(options.name)) throw new Error('--name must be 1-64 letters, digits, spaces, dots, dashes or underscores.');
  }
  return options;
}

/** Returns the control plane origin; vault-agent appends /api/fabric itself. */
export function fabricServer(raw, { allowInsecureHttp = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('--server must be an absolute URL.'); }
  const secure = url.protocol === 'https:' || (allowInsecureHttp && url.protocol === 'http:');
  if (!secure) throw new Error('--server must use https.');
  if (url.username || url.password || url.search || url.hash) throw new Error('--server cannot carry credentials, a query or a fragment.');
  if (!['', '/', '/api/fabric', '/api/fabric/'].includes(url.pathname)) throw new Error('--server must be the control plane origin or its /api/fabric URL.');
  return url.origin;
}

export function runnerTag(runtime) { return runtime === 'runsc' ? RUNNER_PROFILE_TAG : UNSANDBOXED_TAG; }

/** Isolation shared by the enrollment and the long-running runner container. */
export function sandboxArgs(config, { runtime = 'runsc', network } = {}) {
  const args = [`--runtime=${runtime}`, '--label', `${OWNER_LABEL}=${config.owner}`,
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=512', '--memory=4g',
    '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m', '--user', '1000:1000',
    '--mount', `type=volume,src=${config.volume},dst=/home/vault`,
    '--env', `VAULT_AGENT_TAGS=${runnerTag(runtime)}`];
  if (config.allowShell) args.push('--env', 'VAULT_AGENT_ALLOW_SHELL=1');
  if (network) args.push('--network', network);
  return args;
}

export function enrollArgs(config, options = {}) {
  const args = ['run', '--rm', '--interactive', '--name', `${config.name}-enroll`, ...sandboxArgs(config, options),
    config.image, 'enroll', '--server', config.server, '--name', config.deviceName];
  if (config.server.startsWith('http:')) args.push('--dev');
  return args;
}

export function runnerArgs(config, options = {}) {
  return ['run', '--detach', '--name', config.name, '--restart=unless-stopped', '--stop-timeout=30',
    ...sandboxArgs(config, options), config.image, 'run'];
}

export function createFabricConfig({ server, name, allowShell }) {
  const owner = randomUUID();
  const runner = `vault-cloud-agent-fabric-${owner.replace(/-/g, '').slice(0, 12)}`;
  return { schemaVersion: 1, owner, name: runner, volume: `${runner}-data`, server, deviceName: name, allowShell: Boolean(allowShell) };
}

export async function loadFabricConfig(stateDir) {
  let config;
  try { config = JSON.parse(await readFile(join(stateDir, 'fabric.json'), 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read the Fabric runner configuration; data has not been removed.');
  }
  if (config?.schemaVersion !== 1 || typeof config.owner !== 'string' || !/^vault-cloud-agent-fabric-[a-f0-9]{12}$/.test(config.name) ||
      config.volume !== `${config.name}-data` || typeof config.server !== 'string' || !/^https?:\/\/[^/]+$/.test(config.server) ||
      !NAME_RE.test(config.deviceName ?? '') || typeof config.allowShell !== 'boolean' ||
      (config.image !== undefined && !/^sha256:[0-9a-f]{64}$/.test(config.image)) ||
      (config.agentSha256 !== undefined && !/^[0-9a-f]{64}$/.test(config.agentSha256)) ||
      (config.deviceId !== undefined && !UUID_RE.test(config.deviceId))) {
    throw new Error('Invalid Fabric runner configuration; data has not been removed.');
  }
  return config;
}

async function saveFabricConfig(stateDir, config) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const temporary = join(stateDir, `.fabric-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(stateDir, 'fabric.json'));
}

function checkAgent(bytes) {
  if (bytes.length < 4 || bytes.length > MAX_AGENT_BYTES || bytes[0] !== 0x7f || bytes.toString('latin1', 1, 4) !== 'ELF') {
    throw new Error('vault-agent must be a Linux executable no larger than 128 MiB.');
  }
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** A local binary, or the control plane's published binary checked against its SHA256SUMS. */
export async function obtainAgent(options, server, fetchImpl = globalThis.fetch) {
  if (options.agentBinary) {
    let bytes;
    try { bytes = await readFile(options.agentBinary); } catch { throw new Error('--agent-binary must be a readable file.'); }
    return checkAgent(bytes);
  }
  const base = `${server}/api/fabric/agent/download`;
  const get = async (file) => {
    let response;
    try { response = await fetchImpl(`${base}/${file}`, { redirect: 'error' }); } catch { response = null; }
    if (!response?.ok) throw new Error('Cannot download vault-agent from the control plane. Pass --agent-binary to use a local build.');
    return Buffer.from(await response.arrayBuffer());
  };
  const sums = (await get('SHA256SUMS')).toString('utf8');
  const expected = sums.split('\n').map((line) => line.trim().split(/\s+/)).find((parts) => parts[1]?.replace(/^\*/, '') === AGENT_FILE)?.[0];
  if (!/^[0-9a-f]{64}$/.test(expected ?? '')) throw new Error('The control plane SHA256SUMS does not list vault-agent for linux/amd64.');
  const agent = checkAgent(await get(AGENT_FILE));
  if (agent.sha256 !== expected) throw new Error('Downloaded vault-agent does not match SHA256SUMS; nothing was installed.');
  return agent;
}

async function buildImage(agent, run, stream) {
  const context = await mkdtemp(join(tmpdir(), 'vault-cloud-agent-fabric-'));
  try {
    const assets = new URL('../assets/fabric/', import.meta.url);
    await copyFile(fileURLToPath(new URL('Dockerfile', assets)), join(context, 'Dockerfile'));
    await copyFile(fileURLToPath(new URL('entrypoint.sh', assets)), join(context, 'entrypoint.sh'));
    await writeFile(join(context, 'vault-agent'), agent.bytes, { mode: 0o755 });
    const tag = `vault-cloud-agent-fabric:${agent.sha256.slice(0, 12)}`;
    await run(['build', '--platform=linux/amd64', '--tag', tag, '--build-arg', `VAULT_AGENT_SHA256=${agent.sha256}`, context], { stream });
    const image = await run(['image', 'inspect', '--format', '{{.Id}}', tag]);
    if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Docker did not return a valid built image identity.');
    return image;
  } finally { await rm(context, { recursive: true, force: true }); }
}

async function ensureVolume(config, run) {
  const names = await run(['volume', 'ls', '--filter', `name=^${config.volume}$`, '--format', '{{.Name}}']);
  if (!names.split('\n').includes(config.volume)) {
    await run(['volume', 'create', '--label', `${OWNER_LABEL}=${config.owner}`, config.volume]);
    return;
  }
  const volume = JSON.parse(await run(['volume', 'inspect', config.volume]))[0];
  if (volume?.Labels?.[OWNER_LABEL] !== config.owner) throw new Error('Fabric runner volume is not owned by this configuration; refusing to reuse it.');
}

async function readStdinLine() {
  if (process.stdin.isTTY) throw new Error('Pipe the enrollment code on stdin (it is never accepted as an argument).');
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > 4096) break;
  }
  return data;
}

function enrollmentCode(raw) {
  const lines = String(raw ?? '').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== 1 || !CODE_RE.test(lines[0].trim())) throw new Error('Expected a single-line Fabric enrollment code on stdin.');
  return lines[0].trim();
}

function lastJson(output) {
  for (const line of output.split('\n').reverse()) {
    try { const value = JSON.parse(line); if (value && typeof value === 'object') return value; } catch { /* Diagnostics are ignored. */ }
  }
  return null;
}

async function withLock(stateDir, task) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const lockPath = join(stateDir, 'fabric.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another Fabric enrollment is in progress (fabric.lock). Remove it only after verifying that process has stopped.');
    throw new Error('Cannot lock the Fabric runner state.');
  }
  try { await lock.writeFile(String(process.pid)); return await task(); } finally { await lock.close(); await unlink(lockPath); }
}

/**
 * Dependencies are injectable for tests: `runtime` (default runsc; anything else skips the gVisor
 * check and is tagged unsandboxed), `network` (Docker network), `allowInsecureHttp`, `fetch`,
 * `readInput`. None of them is reachable from the command line.
 */
export async function runFabric(argv, dependencies = {}) {
  const { run = docker, write = (line) => console.log(line), runtime = 'runsc', network, allowInsecureHttp = false,
    fetch: fetchImpl = globalThis.fetch, readInput = readStdinLine } = dependencies;
  const options = parseFabricOptions(argv);
  if (['help', '--help'].includes(options.command)) { write(FABRIC_HELP); return; }
  const emit = (value, message) => write(options.json ? JSON.stringify(value) : message);
  const sandbox = { runtime, network };
  const gvisor = async () => { if (runtime === 'runsc') await requireGvisor(run); };

  if (options.command === 'enroll') {
    return withLock(options.stateDir, async () => {
      const existing = await loadFabricConfig(options.stateDir);
      if (existing?.deviceId) throw new Error('This state directory already has an enrolled Fabric runner. Use a separate --state-dir for another device.');
      const server = fabricServer(options.server, { allowInsecureHttp });
      const code = enrollmentCode(await readInput());
      await gvisor();
      const platform = await run(['info', '--format', '{{.OSType}}/{{.Architecture}}']);
      if (!/^linux\/(x86_64|amd64)$/.test(platform)) throw new Error('The Fabric runner currently requires a Linux x64 Docker daemon.');
      const agent = await obtainAgent(options, server, fetchImpl);
      const config = { ...(existing ?? createFabricConfig({ server, name: options.name, allowShell: options.allowShell })),
        server, deviceName: options.name, allowShell: options.allowShell };
      if (!config.image || config.agentSha256 !== agent.sha256) {
        config.image = await buildImage(agent, run, !options.json);
        config.agentSha256 = agent.sha256;
      }
      await saveFabricConfig(options.stateDir, config);
      await ensureVolume(config, run);
      const result = lastJson(await run(enrollArgs(config, sandbox), { input: `${code}\n` }));
      if (!UUID_RE.test(result?.deviceId ?? '')) throw new Error('Fabric enrollment did not return a device; the code may be expired or already used.');
      config.deviceId = result.deviceId;
      await saveFabricConfig(options.stateDir, config);
      emit({ enrolled: true, deviceId: config.deviceId, name: config.deviceName, status: result.status ?? null, tag: runnerTag(runtime) },
        `Fabric runner enrolled as device ${config.deviceId} (${result.status ?? 'unknown'}). Run vault-cloud-agent fabric start.`);
    });
  }

  const config = await loadFabricConfig(options.stateDir);
  if (!config?.deviceId) {
    if (options.command === 'status') { emit({ enrolled: false }, 'Fabric runner is not enrolled.'); return; }
    throw new Error('Run vault-cloud-agent fabric enroll first.');
  }
  const container = await inspectContainer(config, run);
  if (options.command === 'stop') {
    if (container?.State?.Running) await run(['stop', '--time', '30', config.name]);
    emit({ stopped: true, volume: config.volume }, 'Fabric runner stopped. Running jobs were checkpointed and released; the device stays enrolled.');
    return;
  }
  if (options.command === 'start') {
    await gvisor();
    if (container && container.HostConfig?.Runtime !== runtime) {
      throw new Error('Existing Fabric runner container does not use the expected runtime; refusing to start it.');
    }
    if (!container) { await ensureVolume(config, run); await run(runnerArgs(config, sandbox)); }
    else if (!container.State?.Running) await run(['start', config.name]);
    emit({ started: true, container: config.name, deviceId: config.deviceId }, 'Fabric runner started; it claims Fabric jobs for this device.');
    return;
  }
  let agent = null;
  if (container?.State?.Running) {
    try { agent = lastJson(await run(['exec', config.name, '/usr/local/bin/vault-fabric-runner', 'status'])); } catch { agent = null; }
  }
  const sanitized = agent && JSON.parse(JSON.stringify(agent, (key, value) => /token|secret|password|private.?key/i.test(key) ? undefined : value));
  const result = { enrolled: true, deviceId: config.deviceId, name: config.deviceName, server: config.server,
    container: config.name, status: container?.State?.Status ?? 'not-created', runtime: container?.HostConfig?.Runtime ?? null,
    allowShell: config.allowShell, agent: sanitized };
  emit(result, `Fabric runner ${config.deviceId}: ${result.status}; runtime ${result.runtime ?? 'none'}; ${config.server}`);
}

import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';

export const defaultStateDir = () => join(homedir(), '.config', 'vault-cloud-agent');

export function privateAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
  }
  return isIP(address) === 6 && (address === '::1' || /^f[cd][0-9a-f]{2}:/i.test(address));
}

export function parseOptions(argv) {
  const command = argv[0] ?? 'help';
  if (!['install', 'start', 'status', 'pair', 'stop', 'projects', 'devices', 'approve', 'revoke', 'help', '--help', '--version'].includes(command)) {
    throw new Error('Unknown command. Use vault-cloud-agent help.');
  }
  const options = { command, stateDir: defaultStateDir(), bind: '127.0.0.1', port: 6768, projects: [], grants: [] };
  let firstFlag = 1;
  if (command === 'approve' || command === 'revoke') {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(argv[1] ?? '')) {
      throw new Error('A specific device ID from vault-cloud-agent devices is required.');
    }
    options.deviceId = argv[1];
    firstFlag = 2;
  }
  const values = new Set(['--state-dir', '--bind', '--port', '--project', '--writable-project']);
  for (let i = firstFlag; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') { options.json = true; continue; }
    if (command === 'approve' && ['--terminals', '--files', '--git'].includes(flag)) {
      if (!options.grants.includes(flag)) options.grants.push(flag);
      continue;
    }
    if (!values.has(flag)) throw new Error(`Unknown flag ${flag}.`);
    if (flag !== '--state-dir' && command !== 'install') throw new Error(`${flag} is only accepted during install.`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--state-dir') options.stateDir = resolve(value);
    if (flag === '--bind') options.bind = value;
    if (flag === '--port') {
      if (!/^\d+$/.test(value)) throw new Error('port must be an integer from 1 to 65535.');
      options.port = Number(value);
    }
    if (flag === '--project' || flag === '--writable-project') {
      options.projects.push({ source: resolve(value), readOnly: flag === '--project' });
    }
  }
  if (!privateAddress(options.bind)) throw new Error('--bind must be a literal loopback or private/VPN IP.');
  if (options.port < 1 || options.port > 65535) throw new Error('port must be from 1 to 65535.');
  if (command === 'approve' && !options.grants.length) throw new Error('Select at least one explicit capability: --terminals, --files or --git.');
  return options;
}

export async function createConfig(options) {
  const owner = randomUUID();
  const name = `vault-cloud-agent-${owner.slice(0, 12)}`;
  const projects = [];
  for (const project of options.projects) {
    let source;
    try {
      source = await realpath(project.source);
      if (!(await stat(source)).isDirectory()) throw new Error('not a directory');
    } catch { throw new Error('Each project must be an existing directory.'); }
    if (/[,\x00-\x1f\x7f]/.test(source)) throw new Error('Project paths cannot contain a comma or control delimiter.');
    if (projects.some((entry) => entry.source === source)) throw new Error('Project directory was specified more than once.');
    const label = basename(source).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60) || 'project';
    projects.push({ source, target: `/projects/${projects.length + 1}-${label}`, readOnly: project.readOnly });
  }
  return { schemaVersion: 1, owner, name, volume: `${name}-data`, bind: options.bind, port: options.port, projects };
}

export async function saveConfig(stateDir, config) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const temporary = join(stateDir, `.config-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(stateDir, 'config.json'));
}

export async function loadConfig(stateDir) {
  try {
    const config = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'));
    if (config.schemaVersion !== 1 || typeof config.owner !== 'string' ||
        !/^vault-cloud-agent-[a-f0-9-]+$/.test(config.name) ||
        config.volume !== `${config.name}-data` || !privateAddress(config.bind) ||
        (config.image !== undefined && !/^sha256:[0-9a-f]{64}$/.test(config.image)) ||
        !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !Array.isArray(config.projects)) {
      throw new Error('Invalid configuration.');
    }
    for (const project of config.projects) {
      if (typeof project.source !== 'string' || !project.source.startsWith('/') ||
          /[,\x00-\x1f\x7f]/.test(project.source) || !/^\/projects\/\d+-[\w.-]+$/.test(project.target) ||
          typeof project.readOnly !== 'boolean') throw new Error('Invalid project configuration.');
    }
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read Cloud Agent configuration. Restore your config backup; data has not been removed.');
  }
}

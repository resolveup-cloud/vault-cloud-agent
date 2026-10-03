import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const assets = new URL('../assets/', import.meta.url);

test('runtime collector keeps pairing credentials out of stdout and persists only latest readiness privately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-agent-output-'));
  const input = join(dir, 'input');
  const ready = JSON.stringify({ type: 'vault_server_ready', schemaVersion: 1, pairing: { url: 'secret-pair-link' } });
  await writeFile(input, 'diagnostic\n' + ready + '\n');
  const result = await exec('python3', [new URL('capture-ready.py', assets).pathname, input, dir]).catch((error) => ({ error }));
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal((await readFile(join(dir, 'vault-cloud-agent-runtime-output'), 'utf8')).trim(), ready);
  assert.equal((await stat(join(dir, 'vault-cloud-agent-runtime-output'))).mode & 0o777, 0o600);
});

test('build requires checksum verification before runtime extraction and contains no account secrets', async () => {
  const dockerfile = await readFile(new URL('Dockerfile', assets), 'utf8').catch(() => '');
  assert.match(dockerfile, /sha256sum --check/);
  assert.ok(dockerfile.indexOf('sha256sum --check') < dockerfile.indexOf('python3 /usr/local/lib/vault-cloud-agent/extract-runtime.py'));
  assert.match(dockerfile, /USER vault:vault/);
  assert.doesNotMatch(dockerfile, /ANTHROPIC_AUTH_TOKEN|LITELLM_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|vault-pair-controller/);
  const start = await readFile(new URL('start.sh', assets), 'utf8');
  assert.doesNotMatch(start, /--no-pairing|--no-sandbox/);
  assert.match(start, /--pairing-address "\$\{VAULT_PAIRING_ADDRESS/);
  assert.match(start, /umask 077/);
  await exec('bash', ['-n', new URL('start.sh', assets).pathname]);
});

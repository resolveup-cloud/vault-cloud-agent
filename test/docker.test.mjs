import test from 'node:test';
import assert from 'node:assert/strict';
const subject = await import('../lib/docker.mjs').catch(() => ({}));
const config = { schemaVersion: 1, owner: 'abc123', name: 'vault-cloud-agent-abc123', volume: 'vault-cloud-agent-abc123-data', bind: '127.0.0.1', port: 6768, image: 'sha256:123', projects: [{ source: '/my project', target: '/projects/1-project', readOnly: true }] };
function offer(overrides = {}) {
  const payload = { v: 2, scope: 'runtime', endpoint: 'ws://127.0.0.1:6768', pairedDeviceId: '01234567-89ab-cdef-0123-456789abcdef', publicKeyB64: Buffer.alloc(32, 1).toString('base64'), deviceToken: 'private-token', ...overrides };
  return 'vault-desktop://pair?code=' + Buffer.from(JSON.stringify(payload)).toString('base64url');
}

test('run plan fences ingress, runs unprivileged, and mounts only explicit projects', () => {
  assert.equal(typeof subject.runArgs, 'function');
  const args = subject.runArgs(config);
  assert.ok(args.includes('127.0.0.1:6768:6768'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--runtime=runsc'));
  assert.ok(args.includes('--security-opt=no-new-privileges:true'));
  assert.ok(args.includes('type=volume,src=vault-cloud-agent-abc123-data,dst=/home/vault'));
  assert.ok(args.includes('type=bind,src=/my project,dst=/projects/1-project,readonly'));
  assert.ok(args.includes('VAULT_PAIRING_ADDRESS=127.0.0.1:6768'));
  assert.ok(!args.includes('--rm'));
  assert.ok(!args.includes('--privileged'));
  assert.ok(!args.some((x) => /seccomp=unconfined|apparmor=unconfined/.test(x)));
  assert.ok(!args.some((x) => /docker.sock|no-pairing|no-sandbox/.test(x)));
});

test('IPv6 publication uses bracketed literal address', () => {
  assert.equal(typeof subject.runArgs, 'function');
  const args = subject.runArgs({ ...config, bind: '::1' });
  assert.ok(args.includes('[::1]:6768:6768'));
  assert.ok(args.includes('VAULT_PAIRING_ADDRESS=[::1]:6768'));
});

test('pair extracts only versioned readiness and requires E2EE runtime offer', () => {
  assert.equal(typeof subject.readPairing, 'function');
  const ready = { type: 'vault_server_ready', schemaVersion: 1, pairing: { available: true, scope: 'runtime', url: offer(), endpoint: 'ws://127.0.0.1:6768' } };
  assert.equal(subject.readPairing('startup\n' + JSON.stringify(ready) + '\n').url, ready.pairing.url);
  assert.throws(() => subject.readPairing(JSON.stringify({ ...ready, pairing: { available: false, reason: 'e2ee_key_unavailable' } })), /unavailable/);
  assert.throws(() => subject.readPairing(JSON.stringify({ ...ready, pairing: { ...ready.pairing, scope: 'mobile' } })), /runtime/);
  assert.throws(() => subject.readPairing('startup without readiness'), /ready/);
});

test('pair refuses a missing encryption key, expired offer or wrong advertised endpoint', () => {
  const ready = (payload, endpoint = 'ws://127.0.0.1:6768') => JSON.stringify({ type: 'vault_server_ready', schemaVersion: 1, pairing: { available: true, scope: 'runtime', url: offer(payload), endpoint } });
  assert.throws(() => subject.readPairing(ready({ publicKeyB64: '' }), config), /encryption/);
  assert.throws(() => subject.readPairing(ready({ endpoint: 'ws://172.17.0.2:6768' }), config), /endpoint/);
  assert.throws(() => subject.readPairing(ready({ expiresAt: Date.now() - 1 }), config), /expired/);
  assert.throws(() => subject.readPairing(ready({ relay: { inviteExpiresAt: Date.now() - 1 } }), config), /relay|expired/);
});

test('container operations refuse a foreign container without leaking inspect output', () => {
  assert.equal(typeof subject.verifyOwnership, 'function');
  assert.doesNotThrow(() => subject.verifyOwnership({ Config: { Labels: { 'dev.vault.cloud-agent.owner': 'abc123' } } }, config));
  assert.throws(() => subject.verifyOwnership({ Config: { Labels: { 'dev.vault.cloud-agent.owner': 'other' }, Env: ['SECRET=private'] } }, config), /owned/);
});

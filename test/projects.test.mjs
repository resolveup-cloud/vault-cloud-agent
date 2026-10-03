import test from 'node:test';
import assert from 'node:assert/strict';
import { registerProjects } from '../lib/projects.mjs';

test('explicit mounts register through local RPC once without granting capabilities or altering files', async () => {
  const groups = [];
  const folders = [];
  const calls = [];
  const client = { call: async (method, params) => {
    calls.push({ method, params });
    if (method === 'projectGroup.list') return { result: { groups } };
    if (method === 'folderWorkspace.list') return { result: { folderWorkspaces: folders } };
    if (method === 'projectGroup.create') { const group = { ...params, id: 'group' }; groups.push(group); return { result: { group } }; }
    if (method === 'folderWorkspace.create') { const folderWorkspace = { ...params, id: 'folder' }; folders.push(folderWorkspace); return { result: { folderWorkspace } }; }
    throw new Error('unexpected mutation');
  } };
  const mounts = [{ target: '/projects/1-reference', readOnly: true }];
  const first = await registerProjects(client, mounts);
  assert.deepEqual(await registerProjects(client, mounts), first);
  assert.equal(calls.filter(({ method }) => method === 'projectGroup.create').length, 1);
  assert.equal(calls.filter(({ method }) => method === 'folderWorkspace.create').length, 1);
  assert.deepEqual(first.projects, [{ path: mounts[0].target, readOnly: true, worktree: 'id:folder:folder' }]);
  assert.ok(calls.every(({ method }) => /^(projectGroup|folderWorkspace)\.(list|create)$/.test(method)));
});

test('unmounted or malformed project paths are refused before RPC', async () => {
  let called = false;
  const client = { call: async () => { called = true; } };
  await assert.rejects(registerProjects(client, [{ target: '/home/vault', readOnly: true }]), /mount/);
  assert.equal(called, false);
});


test('projects uses the authenticated bundled local client and only configured mount arguments', async () => {
  const { localProjects } = await import('../lib/projects.mjs');
  const calls = [];
  const result = await localProjects({ name: 'owned-container', projects: [
    { source: '/private/host-source', target: '/projects/1-reference', readOnly: true }
  ] }, async args => { calls.push(args); return '{"projects":[]}'; });
  assert.deepEqual(result, { projects: [] });
  assert.deepEqual(calls[0].slice(0, 7), ['exec', '--user', 'vault', 'owned-container', 'node', '-e', calls[0][6]]);
  assert.match(calls[0][6], /new RuntimeClient\(undefined, 20000, null, null\)/);
  assert.doesNotMatch(calls[0].join(' '), /host-source|bypassAll|deviceToken|link\.approve/);
  assert.deepEqual(JSON.parse(calls[0][7]), [{ target: '/projects/1-reference', readOnly: true }]);
});

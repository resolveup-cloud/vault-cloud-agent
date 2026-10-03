// Register only directories explicitly mounted by this installation, through the
// authenticated local runtime. Never edit runtime persistence or grant devices.
export async function registerProjects(client, mounts) {
  if (!Array.isArray(mounts) || mounts.some((mount) =>
    !/^\/projects\/\d+-[\w.-]+$/.test(mount.target) || typeof mount.readOnly !== 'boolean')) {
    throw new Error('Only configured project mounts may be registered.');
  }
  const groups = (await client.call('projectGroup.list')).result.groups;
  const folders = (await client.call('folderWorkspace.list')).result.folderWorkspaces;
  const projects = [];
  for (const mount of mounts) {
    let folder = folders.find((entry) => entry.folderPath === mount.target && !entry.connectionId);
    if (!folder) {
      let group = groups.find((entry) => entry.parentPath === mount.target && !entry.connectionId);
      if (!group) {
        group = (await client.call('projectGroup.create', {
          name: mount.target.split('/').at(-1), parentPath: mount.target
        })).result.group;
        groups.push(group);
      }
      folder = (await client.call('folderWorkspace.create', {
        projectGroupId: group.id, name: group.name, folderPath: mount.target
      })).result.folderWorkspace;
      folders.push(folder);
    }
    projects.push({ path: mount.target, readOnly: mount.readOnly, worktree: `id:folder:${folder.id}` });
  }
  return { projects };
}

export async function localProjects(config, run) {
  const script = `
    const { RuntimeClient } = require('/opt/vault/squashfs-root/resources/app.asar.unpacked/out/cli/runtime/client.js');
    const client = new RuntimeClient(undefined, 20000, null, null);
    (${registerProjects.toString()})(client, JSON.parse(process.argv[1]))
      .then(result => console.log(JSON.stringify(result)))
      .catch(() => { console.error('Local project registration failed; check runtime health and mounted directory access.'); process.exitCode = 1; });
  `;
  const output = await run(['exec', '--user', 'vault', config.name, 'node', '-e', script,
    JSON.stringify(config.projects.map(({ target, readOnly }) => ({ target, readOnly })))]);
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('Cannot register projects; check runtime health and mounted directory access.'); }
  if (!Array.isArray(result?.projects)) throw new Error('Invalid project registration response.');
  return result;
}

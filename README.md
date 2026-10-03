# Vault Cloud Agent

Run Vault's existing headless Desktop runtime and coding agents on a machine or
server you own. The first runtime target is **Linux x64 through Docker**. The host
CLI needs Node.js 20 or newer and access to a Linux x64 Docker daemon with the
**gVisor `runsc` runtime** registered. It has no
npm dependencies. Docker daemon access grants broad host control; use an account
and machine you trust.

## Host prerequisite

Install gVisor and register `runsc` with your Docker daemon using the
[official gVisor Docker setup guide](https://gvisor.dev/docs/user_guide/quick_start/docker/).
Perform any daemon restart during your own maintenance window. Verify that
`docker info --format '{{json .Runtimes}}'` includes `runsc` before installing.
Cloud Agent checks this prerequisite before building and before every start,
and always selects `--runtime=runsc`; it does not change the host's Docker setup.

Ordinary Docker's default seccomp policy can block the user namespaces needed by
Chromium's sandbox. This package requires gVisor rather than relaxing seccomp,
enabling a SUID helper or disabling the Chromium sandbox. A preexisting container
using another runtime is refused on start; `status` and `stop` remain available,
and its configuration and data volume are retained for an administrator to migrate.

## Install

Version 0.1.0 pins the checksum-verified Desktop 0.11.4 Linux runtime.
Install the GitHub release asset:

```sh
npm install --global https://github.com/resolveup-cloud/vault-cloud-agent/releases/download/v0.1.0/vault-cloud-agent-0.1.0.tgz
vault-cloud-agent install
vault-cloud-agent start
vault-cloud-agent status
vault-cloud-agent projects
vault-cloud-agent pair
```

Wait for healthy status before registering projects or pairing. Distribution is
through the GitHub release asset; a public npm registry package is not required.
For a local checkout, use `npm pack`, then
`npm install --global ./vault-cloud-agent-0.1.0.tgz`.

`install` builds a local Docker image from a checksum-pinned Desktop AppImage and
creates an owned persistent volume. It can take several minutes and downloads
the runtime, Ubuntu packages and pinned Codex/Claude CLIs. It supplies no account
credentials. Repeating `install` reuses a completed installation. If a build
failed, repeating it resumes with the retained configuration. It does not upgrade
an existing image or restart a running workload.

## Connect privately

Default ingress publishes only `127.0.0.1:6768` on the Docker host. To connect from
another computer, establish an SSH tunnel before opening the pairing link:

```sh
ssh -N -L 6768:127.0.0.1:6768 your-server
```

Keep the tunnel open on the computer running Vault Desktop, then run
`vault-cloud-agent pair` on the server. Open the printed link on that trusted
computer, or paste it into Vault's add-computer pairing flow. The loopback
address in the offer refers to the SSH tunnel on the client.

For a host already on your private VPN/Tailscale network, opt in to publishing on
that interface when installing:

```sh
vault-cloud-agent install --bind 100.64.1.20 --port 6768
vault-cloud-agent start
vault-cloud-agent pair
```

Replace the address with the host's actual private interface IP. Public,
wildcard, DNS and IPv4-mapped IPv6 addresses are refused. Private IPv4, loopback,
Tailscale's address range and IPv6 ULA addresses are accepted. Binding a private
IP alone does not configure a VPN or firewall: keep that network private and do
not add public port forwarding, a public plaintext proxy or a Tailscale Funnel.
The pairing endpoint must match the host IP and published port exactly. The
runtime listens on the container's interface; `--pairing-address` advertises the
host endpoint, while Docker restricts publication.

## Approve only the intended computer

The link contains a per-device authentication credential and the runtime's
public key. Show it only to the computer you intend to trust. The default runtime
policy allows inspection but denies write/terminal capabilities. After pairing,
list devices and approve the specific device locally on the server:

```sh
vault-cloud-agent devices
vault-cloud-agent approve DEVICE_ID --terminals --files --git
```

Use the device UUID shown by `devices`. Choose only the capabilities needed.
`--terminals` permits terminal/agent operations, `--files` permits file operations,
and `--git` permits Git/worktree operations. Worktree creation needs both Git and
terminal permission; project synchronization needs terminal and files permission.
Shell access can act on files accessible to the container user, so capability
flags are not a shell-command sandbox. This wrapper never grants bypass-all.
Choosing both `--terminals` and `--files` also explicitly enables computer sharing
and Pair execution for this approved device; the wrapper adds the runtime's
`--pair` flag. Approving only one capability does not enable Pair.

To withdraw access:

```sh
vault-cloud-agent revoke DEVICE_ID
```

These calls run the bundled local runtime CLI as `vault`, preserving its device
identity, authorization checks and revocation behavior. Command mapping:

| Agent command | Bundled runtime command |
| --- | --- |
| `devices` | `vault-desktop link devices --json` |
| `approve ID --terminals --files --git` | `vault-desktop link approve --device ID --terminals --files --git --pair --json` |
| `revoke ID` | `vault-desktop link revoke --device ID --json` |

`pair` reveals the current startup offer; it does not mint a new grant or rotate
credentials. Direct runtime offers have no automatic expiration. Restarting is
not revocation or guaranteed token rotation. Revoke a leaked or unwanted device
through the runtime's supported local command, then create a new offer through
its supported pairing flow. Do not reuse a credential across multiple computers.
The wrapper validates offer version, scope, public key, token and advertised
endpoint, and refuses expired offers if a future runtime supplies an expiration.
It also queries the live local runtime and refuses a startup credential whose
device has been revoked or removed. That check does not rotate or reauthorize it.

## Projects, persistence and agent accounts

Project mounts are explicit and read-only by default:

```sh
vault-cloud-agent install --project /srv/reference --writable-project /srv/my-project
```

Each mount appears at `/projects/1-reference`, `/projects/2-my-project`, and so
on, in argument order. Paths with spaces work; commas and control characters
are refused because Docker uses them as mount delimiters. No host home, Docker
socket or other host path is automatically mounted. The container user is UID
1000; grant that user appropriate host directory access yourself if needed. The
installer does not change your project ownership or copy host credentials.

After the runtime reports healthy, run `vault-cloud-agent projects` on the server.
This registers only these explicit mounts in the Vault project catalog through
its authenticated local runtime and prints workspace selectors. Repeat it safely:
existing folders and groups are reused. It does not initialize Git, write project
files, grant device permissions or modify runtime database files directly.
Remote computers cannot register project groups under the narrow grants above;
project onboarding stays with the server owner. Read-only mounts remain enforced
by Docker even after a device receives files and terminal capabilities.

Log in to your chosen AI agent using its supported login flow in an approved
Vault terminal. Codex and Claude are included with pinned versions; AI provider
accounts and permissions remain your responsibility. The selected provider
receives context sent to it by the agent.

Configuration lives in `~/.config/vault-cloud-agent/config.json` (directory mode
0700, file mode 0600). It records the owned container, volume, image identity,
private endpoint and explicit mounts, without pairing credentials. Runtime
state, paired-device grants, account configuration and terminal history live
in the named Docker volume at `/home/vault`.

```sh
vault-cloud-agent stop
vault-cloud-agent start
```

Stopping ends live container processes and retains the volume, project mounts
and configuration. There is no automatic data wipe, pruning or uninstall.
Back up the configuration and volume consistently with the runtime stopped.
Do not delete the configuration as an upgrade mechanism: it identifies the
volume owner. `--state-dir /path/to/state` supports a separate installation; use
a different port for each running agent.

## Security boundaries and troubleshooting

Paired runtime connections use Vault's existing NaCl/Curve25519 E2EE transport.
The initial hello carries an ephemeral public key; the authentication token,
RPC requests and responses travel in encrypted frames. The public key from the
private pairing offer pins the runtime identity. There is no added control plane
or protocol fork. The WebSocket listener also supports runtime-local credentials,
so ingress stays private even when paired traffic is encrypted.

Encryption in transit does not hide running workloads or stored data from the
server owner, Docker administrator, hosting provider or an AI provider receiving
context. This container does not promise encrypted storage at rest or an OS
keyring; runtime keys and account credentials require a protected host, volume
and backups. For user-owned infrastructure, you choose the host and who administers it.

`status --json` reports container state, health and configured paths without
credentials. `start` returns after starting the container; wait for healthy
status before pairing. Startup can take several seconds. Ready output and the
last bounded runtime diagnostics are private mode-0600 files inside the
container, not Docker logs. If startup fails, a local administrator can inspect
`/tmp/vault-cloud-agent-private-diagnostics` with `docker exec --user vault`.
Treat those diagnostics as private: they may contain runtime/account details.
Public container logs contain only process lifecycle messages.

The image runs as `vault` under gVisor, drops all Linux capabilities, uses
`no-new-privileges`, and keeps Chromium's sandbox enabled. If startup fails,
inspect the private diagnostics and the gVisor setup; do not disable seccomp,
the sandbox or run the container privileged. A manually removed volume is not
recoverable by this CLI. Docker daemon errors are reported without echoing
arguments or raw runtime output.

## Verify and package

```sh
npm test
npm pack --dry-run
```

Before release, additionally build and run on a real Linux x64 Docker host;
verify the pinned artifact checksum, startup, host publication, E2EE pairing,
default denial, explicit approval, read-only mounts, interactive terminal input,
revocation and restart persistence. Agent login requires your own provider account;
no account credentials are supplied or used in release verification. Unit tests
use a simulated Docker boundary and do not establish these real-container results. The package includes only this CLI, its image
assets and README, with no managed cloud configuration or credentials.

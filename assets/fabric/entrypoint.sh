#!/bin/sh
# Fabric runner entrypoint. The enrollment code arrives on stdin only, so it never
# appears in `docker run` argv, container metadata or the host process list.
set -eu
umask 077
[ "$(id -u)" = 1000 ] && [ -w /home/vault ] || { echo 'Run as the vault user with a writable data volume.' >&2; exit 1; }
cmd="${1:-run}"
[ $# -gt 0 ] && shift
case "$cmd" in
  enroll)
    code=''
    IFS= read -r code || true
    case "$code" in
      ''|*[!A-Za-z0-9-]*) echo 'A single-line enrollment code is required on stdin.' >&2; exit 2 ;;
    esac
    [ "${#code}" -le 64 ] || { echo 'Enrollment code is too long.' >&2; exit 2; }
    exec vault-agent enroll --code "$code" --network noop --json "$@"
    ;;
  run) exec vault-agent run --network noop "$@" ;;
  status) exec vault-agent status --json ;;
  *) echo 'Unsupported runner command.' >&2; exit 2 ;;
esac

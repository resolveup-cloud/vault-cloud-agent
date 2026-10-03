#!/usr/bin/env bash
# Same process supervision as cloud/container/files/start.sh, with user-owned
# ingress, runtime pairing enabled and secret-free Docker output.
set -euo pipefail
umask 077
[[ "$(id -u)" == 1000 && "${HOME:-}" == /home/vault ]] || { echo 'Run as the vault user.' >&2; exit 1; }
[[ -n "${VAULT_PAIRING_ADDRESS:-}" && -w /home/vault ]] || { echo 'Missing private endpoint or writable data volume.' >&2; exit 1; }
unset XDG_CONFIG_HOME
export DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 DISABLE_AUTOUPDATER=1
cd /home/vault

XVFB_PID='' RUNTIME_PID='' CAPTURE_PID=''
stop_all() {
  trap - TERM INT
  if [[ -n "${RUNTIME_PID}" ]] && kill -0 "${RUNTIME_PID}" 2>/dev/null; then
    kill -TERM "${RUNTIME_PID}" 2>/dev/null || true
    for _ in $(seq 1 125); do
      kill -0 "${RUNTIME_PID}" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "${RUNTIME_PID}" 2>/dev/null || true
  fi
  [[ -z "${XVFB_PID}" ]] || kill -TERM "${XVFB_PID}" 2>/dev/null || true
  [[ -z "${CAPTURE_PID}" ]] || kill -TERM "${CAPTURE_PID}" 2>/dev/null || true
}
on_signal() { stop_all; exit 0; }
trap on_signal TERM INT
rm -f -- /tmp/.X99-lock /tmp/.X11-unix/X99 \
  /tmp/vault-cloud-agent-runtime-output /tmp/vault-cloud-agent-private-diagnostics /tmp/vault-cloud-agent-output-pipe
mkdir -p /tmp/.X11-unix
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp -nolisten local >/dev/null 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 75); do
  [[ -S /tmp/.X11-unix/X99 ]] && break
  kill -0 "${XVFB_PID}" 2>/dev/null || { stop_all; echo 'Private display failed.' >&2; exit 1; }
  sleep 0.2
done
[[ -S /tmp/.X11-unix/X99 ]] || { stop_all; echo 'Private display is unavailable.' >&2; exit 1; }
mkfifo -m 0600 /tmp/vault-cloud-agent-output-pipe
python3 /usr/local/lib/vault-cloud-agent/capture-ready.py /tmp/vault-cloud-agent-output-pipe &
CAPTURE_PID=$!
/opt/vault/squashfs-root/vault-desktop serve --port 6768 \
  --pairing-address "${VAULT_PAIRING_ADDRESS}" --json >/tmp/vault-cloud-agent-output-pipe 2>&1 &
RUNTIME_PID=$!
rc=0
wait -n "${XVFB_PID}" "${RUNTIME_PID}" "${CAPTURE_PID}" || rc=$?
echo "Cloud Agent process exited (status ${rc}); stopping." >&2
stop_all
exit $(( rc == 0 ? 1 : rc ))

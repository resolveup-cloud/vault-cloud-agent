"""Capture runtime readiness privately. Never forward credentials into Docker logs."""
from collections import deque
import json
import os
import sys

os.umask(0o077)
source_path = sys.argv[1]
directory = sys.argv[2] if len(sys.argv) > 2 else '/tmp'
diagnostics = deque(maxlen=8)

def save(name, value):
    path = os.path.join(directory, name)
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf8') as output:
        output.write(value)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)

with open(source_path, encoding='utf8', errors='replace') as source:
    while True:
        line = source.readline(65537)
        if not line:
            break
        if len(line) > 65536:
            while line and not line.endswith('\n'):
                line = source.readline(65537)
            continue
        try:
            payload = json.loads(line)
        except (ValueError, TypeError):
            payload = None
        if isinstance(payload, dict) and payload.get('type') == 'vault_server_ready' and payload.get('schemaVersion') == 1:
            save('vault-cloud-agent-runtime-output', line)
        else:
            diagnostics.append(line[:8192])
            save('vault-cloud-agent-private-diagnostics', ''.join(diagnostics))

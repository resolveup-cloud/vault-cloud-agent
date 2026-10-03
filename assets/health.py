"""Check readiness without emitting the pairing credential."""
import json
import sys

try:
    with open('/tmp/vault-cloud-agent-runtime-output', encoding='utf8') as source:
        ready = json.load(source)
    valid = ready.get('type') == 'vault_server_ready' and ready.get('schemaVersion') == 1
    pairing = ready.get('pairing', {})
    valid = valid and pairing.get('available') is True and pairing.get('scope') == 'runtime'
    sys.exit(0 if valid else 1)
except (OSError, ValueError, TypeError):
    sys.exit(1)

"""Extract the already checksum-verified AppImage without executing its ELF loader.

Uses the same ELF/squashfs boundary as cloud/image/lib/runtime.sh.
"""
import os
import struct
import subprocess
import sys

with open(sys.argv[1], 'rb') as source:
    header = source.read(64)
    if header[:4] != b'\x7fELF' or header[4] != 2 or struct.unpack_from('<H', header, 0x12)[0] != 0x3E:
        sys.exit('Not an x86-64 ELF AppImage')
    table_offset, = struct.unpack_from('<Q', header, 0x28)
    entry_size, count = struct.unpack_from('<HH', header, 0x3A)
    offset = table_offset + entry_size * count
    source.seek(offset)
    if source.read(4) != b'hsqs':
        sys.exit('AppImage squashfs payload is missing')
os.makedirs('/opt/vault', mode=0o755, exist_ok=True)
subprocess.run(['unsquashfs', '-q', '-no-xattrs', '-o', str(offset), '-d', '/opt/vault/squashfs-root', sys.argv[1]], check=True)
for parent, directories, files in os.walk('/opt/vault/squashfs-root'):
    for name in ['.'] + directories + files:
        target = parent if name == '.' else os.path.join(parent, name)
        if os.path.islink(target):
            continue
        mode = os.stat(target).st_mode
        executable = os.path.isdir(target) or bool(mode & 0o111)
        # Preserve root-only write access and remove setuid/setgid helpers.
        os.chmod(target, 0o755 if executable else 0o644)

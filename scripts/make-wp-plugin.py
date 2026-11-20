#!/usr/bin/env python3
"""Builds wordpress-plugin/dist/botwa-chat.zip (generic package, no pre-filled settings). Chats get their own pre-filled package from the panel."""
import os, zipfile
root = os.path.join(os.path.dirname(__file__), '..', 'wordpress-plugin')
src = os.path.join(root, 'botwa-chat')
out = os.path.join(root, 'dist'); os.makedirs(out, exist_ok=True)
path = os.path.join(out, 'botwa-chat.zip')
with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
    for d, dirs, files in os.walk(src):
        dirs[:] = sorted(x for x in dirs if x != 'tests')
        for f in sorted(files):
            if f == 'botwa-chat-defaults.php': continue
            full = os.path.join(d, f)
            z.write(full, os.path.join('botwa-chat', os.path.relpath(full, src)))
print(path, os.path.getsize(path), 'bytes')

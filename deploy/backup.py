#!/usr/bin/env python3
"""Consistent SQLite + auth-secret snapshot; run as root via the supplied timer."""
import datetime
import os
from pathlib import Path
import shutil
import sqlite3

os.umask(0o077)
source = Path('/var/lib/stripsearch')
root = Path('/var/backups/stripsearch')
root.mkdir(mode=0o700, parents=True, exist_ok=True)
now = datetime.datetime.now(datetime.timezone.utc)
target = root / now.strftime('%Y%m%dT%H%M%S.%fZ')
target.mkdir(mode=0o700)
try:
    with sqlite3.connect(f'file:{source / "stripsearch.sqlite"}?mode=ro', uri=True) as src:
        with sqlite3.connect(target / 'stripsearch.sqlite') as dst:
            src.backup(dst)
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('backup integrity check failed')
    secret = source / 'auth-secret'
    if secret.exists():
        shutil.copyfile(secret, target / 'auth-secret')
    (target / 'complete').touch(mode=0o600)
except BaseException:
    shutil.rmtree(target)
    raise
# Remove only complete, app-owned backups older than 14 days.
for old in root.iterdir():
    if old.is_dir() and not old.is_symlink() and (old / 'complete').is_file():
        try:
            created = datetime.datetime.strptime(old.name, '%Y%m%dT%H%M%S.%fZ').replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            continue
        if now - created > datetime.timedelta(days=14):
            shutil.rmtree(old)
print(f'Backup verified: {target.name}')

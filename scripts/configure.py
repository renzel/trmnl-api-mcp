#!/usr/bin/env python3
"""Save a TRMNL account key using a hidden prompt, outside the source project."""
import getpass
import os
from pathlib import Path
import sys
import tempfile


def main():
    if not sys.stdin.isatty():
        raise SystemExit('Run this script in your terminal so the API key can be entered without echo.')
    print('Copy your User API Key from https://trmnl.com/account.')
    print('It will be stored locally for playlist access. Input is hidden.')
    key = getpass.getpass('TRMNL User API Key: ').strip()
    if not key or any(c.isspace() for c in key) or len(key) > 4095:
        raise SystemExit('Expected a single non-empty account API token; no file was changed.')
    if key.startswith('ps_mcp_'):
        raise SystemExit('This is a plugin MCP key. Use your account User API Key instead.')
    directory = Path.home() / '.config' / 'trmnl-playlist'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise SystemExit('Credential directory must not be a symbolic link.')
    directory.chmod(0o700)
    fd, name = tempfile.mkstemp(prefix='.key-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(key + '\n')
        os.replace(name, directory / 'account-api-key')
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print('Saved account key with permissions 600. It was not printed or sent anywhere.')
    print('The MCP server reads the key on each call; it does not need a restart after key changes.')


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        raise SystemExit('\nCancelled; the API key was not saved.')

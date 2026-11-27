#!/usr/bin/env python3
"""Standard MCP stdio proxy to the single local Sonar Unix-socket authority; never creates a DB."""
import http.client
import json
import os
import socket
import sys


def resolve_socket_path():
    if os.environ.get('SONAR_SOCKET'):
        return os.path.expanduser(os.environ['SONAR_SOCKET'])
    candidates = [
        os.environ.get('SONAR_CLIENT_CONFIG'),
        '~/.config/sonar/client.json',
        '~/.config/sonar/config.json',
        '/etc/sonar/config.json',
    ]
    for raw in candidates:
        if not raw:
            continue
        cfg_path = os.path.expanduser(raw)
        try:
            with open(cfg_path, 'r', encoding='utf-8') as f:
                cfg_sock = json.load(f).get('socket')
                if isinstance(cfg_sock, str) and cfg_sock.strip():
                    return os.path.expanduser(cfg_sock.strip())
        except (OSError, ValueError):
            pass
    if os.environ.get('SONAR_DEFAULT_SOCKET'):
        return os.path.expanduser(os.environ['SONAR_DEFAULT_SOCKET'])
    user_sock = os.path.expanduser('~/.local/share/sonar/sonar.sock')
    if os.path.exists(user_sock) or not os.path.exists('/run/sonar/mcp.sock'):
        return user_sock
    return '/run/sonar/mcp.sock'


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(resolve_socket_path())


def request(message):
    c = UnixHTTP('localhost', timeout=180)
    try:
        c.request('POST', '/rpc', json.dumps(message), {'Content-Type': 'application/json'})
        r = c.getresponse()
        raw = r.read()
        if r.status not in (200, 204):
            raise RuntimeError(f'Sonar service returned {r.status}')
        return json.loads(raw) if raw else None
    finally:
        c.close()


if len(sys.argv) > 1:
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    r = request({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': sys.argv[1], 'arguments': args}})
    print(json.dumps(r, ensure_ascii=False))
    sys.exit(1 if r.get('result', {}).get('isError') or r.get('error') else 0)

for line in sys.stdin:
    if not line.strip():
        continue
    message = None
    try:
        message = json.loads(line)
        r = request(message)
        if r is not None:
            print(json.dumps(r, ensure_ascii=False), flush=True)
    except Exception as e:
        if isinstance(message, dict) and 'id' in message:
            print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32000, 'message': f'Sonar memory service unavailable: {e}'}}), flush=True)
        else:
            print(f'Sonar memory service unavailable: {e}', file=sys.stderr, flush=True)

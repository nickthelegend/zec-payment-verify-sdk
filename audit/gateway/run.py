"""Run scoped gateway checks, redacting output before it reaches evidence or the terminal."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
LOG = ROOT / 'audit/gateway'
STATUS = ROOT / 'audit/status/gateway.json'

def redact(value):
    value = re.sub(r'(?i)(?:uivktest1|uivk1|uviewtest1|uview1|secret-extended-key-test1|secret-extended-key-main1)[a-z0-9…]+', '[REDACTED_VIEWING_KEY]', value)
    return re.sub(r'\x1b\[[0-9;]*m', '', value)

if not STATUS.exists():
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    STATUS.write_text(json.dumps([{'id': f'API-{i:03}', 'status': 'PENDING', 'evidence': '', 'fix': ''} for i in range(1, 65)], indent=2) + '\n')

commands = {
    'suite': ['pnpm', '--filter', '@zpv/gateway', 'test', '--reporter=verbose'],
    'http': ['node', '--import', 'tsx', '../../audit/gateway/http.ts'],
    'build': ['pnpm', '--filter', '@zpv/gateway', 'build'],
    'regression': ['pnpm', '--filter', '@zpv/gateway', 'exec', 'vitest', 'run', 'test/startup.test.ts', 'test/status.test.ts', '--reporter=verbose'],
}
SUITE_ROWS = {
    '150 verify requests at once': [22],
    'TX_NOT_FOUND (lightwalletd has not seen': [51],
    'after 5 counted refusals': [53],
    'a lightwalletd quorum shortfall': [54],
    'two concurrent requests with the same payment': [56],
    'a flood of /api/verify calls cannot take': [63],
}

def record_suite_line(line):
    if '✓ test/' not in line:
        return
    for fragment, ids in SUITE_ROWS.items():
        if fragment not in line:
            continue
        for number in ids:
            rows = json.loads(STATUS.read_text())
            row = rows[number - 1]
            row.update(status='PASS', evidence='pnpm --filter @zpv/gateway test --reporter=verbose: ' + line.strip() + '. Log: audit/gateway/suite.txt', fix='Testnet and closed loopback port replace mainnet in the quorum test.' if number == 54 else '')
            STATUS.write_text(json.dumps(rows, indent=2) + '\n')
mode = sys.argv[1]
env = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'KAGE_X402_DIR') if k in os.environ}
binary = ROOT / 'packages/core/target/release/zpay-verify'
env.update(NO_COLOR='1', ZPV_BIN=str(binary))
if len(sys.argv) > 2:
    env['HANKO_AUDIT_ROWS'] = sys.argv[2]
cwd = ROOT / 'packages/gateway' if mode == 'http' else ROOT
LOG.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='hanko-gateway-', dir='/tmp') as tmp:
    env['ZPV_STORE'] = str(Path(tmp) / 'gateway.sqlite')
    start = time.time()
    p = subprocess.Popen(commands[mode], cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
    logname = f'{mode}-rerun-{sys.argv[2].replace(",", "-")}.txt' if len(sys.argv) > 2 else f'{mode}.txt'
    with (LOG / logname).open('w') as f:
        f.write('COMMAND: ' + json.dumps(commands[mode]) + '\nCWD: ' + str(cwd) + '\n')
        f.write('Started UTC: ' + time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + '\n')
        for line in p.stdout:
            clean = redact(line)
            f.write(clean)
            f.flush()
            print(clean, end='', flush=True)
            if mode == 'suite':
                record_suite_line(clean)
        code = p.wait()
        f.write(f'EXIT: {code}\nElapsed seconds: {time.time() - start:.2f}\n')
sys.exit(code)

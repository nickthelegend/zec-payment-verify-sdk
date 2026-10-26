"""Check final audit evidence without emitting fixture credential values."""
from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
LOG = ROOT / 'audit/gateway'
STATUS = ROOT / 'audit/status/gateway.json'
rows = json.loads(STATUS.read_text())
assert [r['id'] for r in rows] == [f'API-{n:03}' for n in range(1, 65)]
assert Counter(r['status'] for r in rows) == {'PASS': 63, 'UNTESTED': 1}
assert rows[36]['status'] == 'UNTESTED' and 'needs KAGE_X402_DIR' in rows[36]['evidence']
assert all(json.loads((LOG / (r['id'] + '.json')).read_text())['status'] == r['status'] for r in rows)

# All printed/logged evidence is tested against the complete published fixture values internally.
keys = []
def credentials(value):
    if isinstance(value, dict):
        for field, child in value.items():
            if field == 'uivk' and isinstance(child, str):
                keys.append(child)
            else:
                credentials(child)
    elif isinstance(value, list):
        for child in value:
            credentials(child)
for name in ('fixtures/testnet.json', 'deployments/testnet.json'):
    credentials(json.loads((ROOT / name).read_text()))
checked = [p for p in LOG.rglob('*') if p.is_file()] + [STATUS]
assert all(not any(key in p.read_text(errors='replace') for key in keys) for p in checked)

# Only inspect command names, never process environments or command-line arguments.
process_rows = subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True).splitlines()
live = {int(line.split(None, 1)[0]) for line in process_rows}
recorded_pids = set()
store_dirs = set()
for path in LOG.glob('API-*.json'):
    data = json.loads(path.read_text())
    for entry in data.get('records', []):
        if isinstance(entry, dict) and 'pid' in entry:
            recorded_pids.add(entry['pid'])
        if isinstance(entry, dict) and isinstance(entry.get('store'), str) and entry['store'].startswith('/tmp/'):
            store_dirs.add(Path(entry['store']).parent)
assert not (recorded_pids & live), 'a recorded audit server/startup PID is still alive'
assert not any(path.exists() for path in store_dirs), 'a disposable HTTP store directory remains'

suite = (LOG / 'suite.txt').read_text()
regression = (LOG / 'regression.txt').read_text()
assert '2 failed | 36 passed (38)' in suite
assert 'Tests  8 passed (8)' in regression
assert 'EXIT: 0' in (LOG / 'build.txt').read_text()
assert 'HTTP audit complete: 0 failed rows' in (LOG / 'http.txt').read_text()
size = sum(p.stat().st_size for p in (ROOT / 'audit').rglob('*') if p.is_file())
assert size < 15_000_000
assert subprocess.run(['git', 'diff', '--check'], cwd=ROOT).returncode == 0
changes = subprocess.check_output(['git', 'diff', '--name-only'], cwd=ROOT, text=True).splitlines()
assert all(name.startswith('packages/gateway/') for name in changes)

# Keep the final fix description precise after the u32-boundary follow-up.
rows[63]['fix'] = "packages/gateway/src/main.ts rejects out-of-range quorum, confirmation floors outside the verifier's u32 range and prices whose quote or 5x report exceeds the Zcash amount limit before listening. Startup regression and real HTTP/default-port rerun passed. Initial failure: audit/gateway/API-064-initial.json."
STATUS.write_text(json.dumps(rows, indent=2) + '\n')
summary = {
    'apiRows': dict(Counter(r['status'] for r in rows)),
    'untested': {'API-037': 'needs KAGE_X402_DIR'},
    'gatewaySuite': {'passed': 36, 'setupErrors': 2, 'setupErrorDependency': 'KAGE_X402_DIR'},
    'regression': {'passed': 8},
    'gatewayBuild': 'PASS',
    'httpRowsFailed': 0,
    'evidenceFilesCheckedForFixtureKeyValues': len(checked),
    'credentialValuesFoundInEvidence': 0,
    'recordedServerOrStartupPidsNoLongerAlive': len(recorded_pids),
    'disposableHttpStoreDirectoriesRemoved': len(store_dirs),
    'auditBytes': size,
    'diffCheck': 'PASS',
    'sourceChangesScopedToGateway': True,
    'transactionsSent': 0,
    'committed': False,
    'pushed': False,
}
(LOG / 'verification.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))

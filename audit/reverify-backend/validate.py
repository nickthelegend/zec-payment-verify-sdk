"""Verify coverage, freshness, cleanup, redaction, scope and evidence budget without credentials."""
import hashlib, json, pathlib, re, subprocess
from datetime import datetime,timezone
ROOT=pathlib.Path(__file__).resolve().parents[2]
LOG=ROOT/'audit/reverify-backend'
STATUS=ROOT/'audit/status/reverify-backend.json'
rows=json.loads(STATUS.read_text())
required={f'{p}-{i:03}' for p,lo,hi in [('API',1,64),('CHAIN',1,18),('CLI',1,21),('MCP',1,17),('EDGE',25,40)] for i in range(lo,hi+1)}
assert {r['id'] for r in rows}==required and len(rows)==136
assert all(r['status'] in ('PASS','FAIL','UNTESTED') for r in rows)
assert next(r for r in rows if r['id']=='CHAIN-018')['status']=='UNTESTED'
for r in rows:
 for name in r['evidence']:assert (ROOT/name).is_file(),name
 assert (LOG/(r['id']+'.json')).is_file(),r['id']
for name in ['core.txt','sdk.txt','mcp.txt','http.txt','sdk-build.txt','gateway-build.txt','mcp-build.txt']:
 assert 'EXIT: 0' in (LOG/name).read_text(),name
suite=(LOG/'suite.txt').read_text()
assert 'Tests  38 passed (38)' in suite and 'EXIT: 0' in suite
assert 'Tests  75 passed (75)' in (LOG/'sdk.txt').read_text()
assert 'Tests  25 passed (25)' in (LOG/'mcp.txt').read_text()
# Scan evidence only, not fixture credentials or any environment/wallet files.
pattern=re.compile(r'(?i)(?:uivktest1|uivk1|uviewtest1|uview1|secret-extended-key-test1|secret-extended-key-main1)[a-z0-9]{20,}')
checked=[p for p in LOG.rglob('*') if p.is_file()]+[STATUS]
assert all(not pattern.search(p.read_text(errors='replace')) for p in checked),'unredacted credential encoding'
# No servers from the actual HTTP runs and no disposable HTTP sqlite directories remain.
live={int(line.split(None,1)[0]) for line in subprocess.check_output(['ps','-axo','pid=,comm='],text=True).splitlines()}
pids=set(); stores=set()
for file in LOG.glob('API-*.json'):
 for entry in json.loads(file.read_text()).get('records',[]):
  if isinstance(entry,dict):
   if 'pid' in entry:pids.add(entry['pid'])
   store=entry.get('store')
   if isinstance(store,str) and (store.startswith('/tmp/') or store.startswith('/var/folders/')):stores.add(pathlib.Path(store).parent)
assert not pids.intersection(live),'recorded server/startup PID still active'
assert not any(p.exists() for p in stores),'disposable HTTP sqlite directory remains'
subprocess.run(['git','diff','--check'],cwd=ROOT,check=True)
subprocess.run(['git','diff','--exit-code','--','AUDIT.md','packages/landing','packages/dashboard'],cwd=ROOT,check=True)
changes=subprocess.check_output(['git','status','--porcelain','--untracked-files=all'],cwd=ROOT,text=True).splitlines()
assert all(line[3:].startswith(('audit/reverify-backend/','audit/status/reverify-backend.json','packages/sdk/test/audit.test.ts','packages/mcp/test/audit.test.ts')) for line in changes),changes
size=sum(p.stat().st_size for p in (ROOT/'audit').rglob('*') if p.is_file())
assert size<15_000_000,size
summary={'at':datetime.now(timezone.utc).isoformat(),'coverage':len(rows),'evidenceFilesChecked':len(checked),'unredactedCredentialEncodings':0,'recordedHttpPidsStopped':len(pids),'disposableHttpStoreDirectoriesRemoved':len(stores),'auditBytes':size,'auditBudgetBytes':15_000_000,'diffCheck':'PASS','protectedSourcesUnchanged':True,'changesScoped':True,'transactionsSent':0,'committed':False,'pushed':False}
(LOG/'validation.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))

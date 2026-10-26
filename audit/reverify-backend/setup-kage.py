"""Fetch only the public, pinned x402 client into an isolated temporary checkout."""
import json, os, pathlib, subprocess, tempfile
from datetime import datetime, timezone
ROOT=pathlib.Path(__file__).resolve().parents[2]
LOG=ROOT/'audit/reverify-backend'
REV='50acc85850aabfde02e6ad334e8cd67eebab8708'
URL='https://github.com/nickthelegend/zec-shielded-x402'
checkout=pathlib.Path(tempfile.mkdtemp(prefix='hanko-reverify-kage-'))/'checkout'
env={k:os.environ[k] for k in ['PATH','HOME'] if k in os.environ}
env['GIT_TERMINAL_PROMPT']='0'
commands=[['git','-c','credential.helper=','clone','--no-checkout','--depth','1','--filter=blob:none',URL,str(checkout)],['git','-C',str(checkout),'sparse-checkout','init','--cone'],['git','-C',str(checkout),'sparse-checkout','set','packages/x402-zcash'],['git','-C',str(checkout),'-c','credential.helper=','fetch','--depth','1','origin',REV],['git','-C',str(checkout),'-c','credential.helper=','checkout','--detach',REV]]
with (LOG/'kage-setup.txt').open('w') as log:
 for command in commands:
  result=subprocess.run(command,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  log.write('COMMAND: '+json.dumps(command)+'\n'+result.stdout+f'\nEXIT: {result.returncode}\n');log.flush()
  if result.returncode:raise SystemExit(result.returncode)
info={'at':datetime.now(timezone.utc).isoformat(),'repository':URL,'revision':REV,'packagePath':str(checkout/'packages/x402-zcash'),'clonedFor':'read-only parser and recorded-payment HTTP client interoperability tests','credentialsUsed':False,'signingOrSending':False}
(LOG/'kage-dependency.json').write_text(json.dumps(info,indent=2)+'\n')
print('Prepared pinned public x402 client; no transaction-producing script executed.')

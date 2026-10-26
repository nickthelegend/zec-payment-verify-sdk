"""Phase 4 read-only backend reruns, sanitized parent environment and redacted logs."""
import json, os, pathlib, re, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
LOG = ROOT / 'audit/reverify-backend'

def redact(s):
    return re.sub(r'(?i)(?:uivktest1|uivk1|uviewtest1|uview1|secret-extended-key-test1|secret-extended-key-main1)[a-z0-9…]+', '[REDACTED_VIEWING_KEY]', s)

COMMANDS = {
 'core': (['cargo', 'test', '--release', '--', '--test-threads=1'], 'packages/core'),
 'core-build': (['cargo', 'build', '--release'], 'packages/core'),
 'sdk': (['pnpm', '--filter', '@zpv/sdk', 'test', '--reporter=verbose'], '.'),
 'gateway': (['pnpm', '--filter', '@zpv/gateway', 'test', '--reporter=verbose'], '.'),
 'mcp': (['pnpm', '--filter', '@zpv/mcp', 'test', '--reporter=verbose'], '.'),
 'sdk-build': (['pnpm', '--filter', '@zpv/sdk', 'build'], '.'),
 'gateway-build': (['pnpm', '--filter', '@zpv/gateway', 'build'], '.'),
 'mcp-build': (['pnpm', '--filter', '@zpv/mcp', 'build'], '.'),
 'http': (['pnpm', '--filter', '@zpv/gateway', 'exec', 'tsx', '../../audit/reverify-backend/http.ts'], '.'),
}

def main():
 mode=sys.argv[1]
 args,cwd=COMMANDS[mode]
 # Exclude dotenv/application credentials; tests load the published demo fixtures internally.
 names=('PATH','HOME','TMPDIR','RUSTUP_HOME','CARGO_HOME','SSL_CERT_FILE','SSL_CERT_DIR')
 env={k:os.environ[k] for k in names if k in os.environ}
 group='mcp' if mode=='mcp' else 'cli-chain'
 env.update(NO_COLOR='1', CARGO_BUILD_JOBS='1', ZPV_BIN=str(ROOT/'packages/core/target/release/zpay-verify'),
   HANKO_AUDIT_DIR='audit/reverify-backend', HANKO_AUDIT_STATUS=f'audit/reverify-backend/{group}-status.json',
   HANKO_AUDIT_COMMAND=f'python3 audit/reverify-backend/run.py {mode}', HANKO_AUDIT_LOG='sdk.txt', HANKO_MCP_AUDIT_LOG='mcp.txt')
 if mode in ('gateway','http') and (LOG/'kage-dependency.json').is_file():
  dependency=json.loads((LOG/'kage-dependency.json').read_text())
  if pathlib.Path(dependency['packagePath'],'src/index.ts').is_file(): env['KAGE_X402_DIR']=dependency['packagePath']
 if mode=='http' and len(sys.argv)>2: env['HANKO_AUDIT_ROWS']=sys.argv[2]
 filename='suite.txt' if mode=='gateway' else mode+'.txt'
 if mode=='http' and len(sys.argv)>2: filename='http-rerun-'+sys.argv[2].replace(',','-')+'.txt'
 start=time.monotonic()
 with (LOG/filename).open('w') as log:
  log.write('COMMAND: '+json.dumps(args)+'\nCWD: '+cwd+'\nSTART: '+time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())+'\n')
  log.flush()
  process=subprocess.Popen(args,cwd=ROOT/cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,errors='replace')
  for line in process.stdout:
   clean=redact(line);log.write(clean);log.flush()
   print(clean,end='',flush=True)
  code=process.wait()
  log.write(f'\nEXIT: {code}\nELAPSED_SECONDS: {time.monotonic()-start:.2f}\n')
 return code
if __name__=='__main__': sys.exit(main())

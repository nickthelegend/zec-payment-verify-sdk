"""Run only core/SDK audit entry points, storing redacted output, never loading dotenv."""
import json, os, pathlib, re, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
LOG = ROOT / 'audit/cli-chain'
def redact(s):
    s = re.sub(r'(?i)(?:uivktest1|uivk1|uviewtest1|uview1|secret-extended-key-test1|secret-extended-key-main1)[a-z0-9…]+', '[REDACTED_VIEWING_KEY]', s)
    return s

def run(name, args, cwd):
    # Do not inspect or copy application credentials; tests load published demo fixtures themselves.
    names = ('PATH', 'HOME', 'TMPDIR', 'RUSTUP_HOME', 'CARGO_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR')
    env = {k: os.environ[k] for k in names if k in os.environ}
    env.update(HANKO_AUDIT_LOG=name+'.txt', NO_COLOR='1', CARGO_BUILD_JOBS='2', ZPV_BIN=str(ROOT / 'packages/core/target/release/zpay-verify'))
    start = time.time()
    p = subprocess.Popen(args, cwd=ROOT / cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace', bufsize=1)
    with (LOG / (name+'.txt')).open('w') as f:
        f.write('COMMAND: '+json.dumps(args)+'\nCWD: '+cwd+'\nSTART: '+time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())+'\n')
        for line in p.stdout:
            clean=redact(line)
            f.write(clean); f.flush()
            print(clean,end='',flush=True)
        code = p.wait()
        f.write(f'\nEXIT: {code}\nELAPSED_SECONDS: {time.time()-start:.2f}\n')
    return code
if __name__=='__main__':
    mode=sys.argv[1]
    commands={
      'core': (['cargo','test','--release','--','--test-threads=1'], 'packages/core'),
      'sdk': (['pnpm','exec','vitest','run','--reporter=verbose'], 'packages/sdk'),
      'audit': (['pnpm','exec','vitest','run','test/audit.test.ts','--reporter=verbose'], 'packages/sdk'),
      'audit-focused': (['pnpm','exec','vitest','run','test/audit.test.ts','--reporter=verbose','-t','EDGE-038'], 'packages/sdk'),
      'audit-types': (['pnpm','exec','tsc','--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--skipLibCheck','--esModuleInterop','test/audit.test.ts'], 'packages/sdk'),
      'sdk-build': (['pnpm','build'], 'packages/sdk'),
    }
    args,cwd=commands[mode]
    sys.exit(run(mode,args,cwd))

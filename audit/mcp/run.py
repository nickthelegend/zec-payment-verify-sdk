"""Run MCP checks with a credential-free parent environment and redacted evidence."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
LOG = ROOT / "audit/mcp"
STATUS = ROOT / "audit/status/mcp.json"


def redact(text):
    return re.sub(
        r"(?i)(?:uivktest1|uivk1|uviewtest1|uview1|secret-extended-key-test1|secret-extended-key-main1)[a-z0-9…]+",
        "[REDACTED_VIEWING_KEY]", text,
    )


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "suite"
    commands = {
        "baseline": ["pnpm", "--filter", "@zpv/mcp", "test"],
        "suite": ["pnpm", "--filter", "@zpv/mcp", "test"],
        "build": ["pnpm", "--filter", "@zpv/mcp", "build"],
        "types": ["pnpm", "--filter", "@zpv/mcp", "exec", "tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "--esModuleInterop", "test/audit.test.ts"],
        "log-initial": ["pnpm", "--filter", "@zpv/mcp", "exec", "vitest", "run", "test/audit.test.ts", "-t", "MCP-017"],
    }
    if mode not in commands:
        raise SystemExit("Expected baseline, suite, build, types or log-initial")
    LOG.mkdir(parents=True, exist_ok=True)
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    if not STATUS.exists():
        STATUS.write_text(json.dumps([
            {"id": f"MCP-{i:03}", "status": "PENDING", "evidence": "Awaiting real stdio audit", "fix": ""}
            for i in range(1, 18)
        ], indent=2) + "\n")
    # No dotenv or application credentials are read. The tests load demo incoming
    # credentials internally, exactly as packages/mcp/test/mcp.test.ts does.
    env = {k: os.environ[k] for k in ("PATH", "HOME", "TMPDIR") if k in os.environ}
    binary = ROOT / "packages/core/target/release/zpay-verify"
    if not binary.exists():
        # Existing read-only verifier from the main checkout; no core rebuild or
        # transaction-producing command is needed for this MCP-only task.
        binary = Path("/Volumes/Extreme SSD/Projects/grokbot/projects/zec-payment-verify-sdk/packages/core/target/release/zpay-verify")
    env.update(ZPV_BIN=str(binary), NO_COLOR="1", HANKO_MCP_AUDIT_LOG=f"{mode}.txt")
    start = time.monotonic()
    with (LOG / f"{mode}.txt").open("w") as log:
        log.write("COMMAND: " + json.dumps(commands[mode]) + "\n")
        log.write("START: " + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "\n")
        process = subprocess.Popen(commands[mode], cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, errors="replace")
        for line in process.stdout:
            clean = redact(line)
            log.write(clean)
            log.flush()
            print(clean, end="", flush=True)
        code = process.wait()
        log.write(f"\nEXIT: {code}\nELAPSED_SECONDS: {time.monotonic() - start:.2f}\n")
    return code


if __name__ == "__main__":
    sys.exit(main())

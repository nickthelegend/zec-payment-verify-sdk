"""Map existing test assertions to remaining AUDIT rows without rerunning other tasks' suites."""
import json, pathlib, re
ROOT=pathlib.Path(__file__).resolve().parents[2]
P=ROOT/'audit/status/cli-chain.json'
rows=json.loads(P.read_text()); by_id={r['id']:r for r in rows}
logs={name:(ROOT/f'audit/cli-chain/{name}.txt').read_text() for name in ['core','sdk']}
def setrow(id,status,evidence,fix=''):
 by_id[id].update(status=status,evidence=evidence,fix=fix)
 P.write_text(json.dumps(rows,indent=2)+'\n')
def passed(log,test):
 text=logs[log]
 assert 'EXIT: 0' in text,log+' did not exit 0'
 assert test in text,(log,test)
 assert any(test in line and ('... ok' in line or '✓' in line) for line in text.splitlines()), (log,test)

def proof(id,checks,evidence):
 for log,test in checks:passed(log,test)
 setrow(id,'PASS',evidence)

proof('CLI-016', [('sdk','two agreeing answers meet a quorum of 2'),('sdk','agreeing refusals stay refusals'),('sdk','the two public testnet indexers:')],
 'Command: python3 audit/cli-chain/run.py sdk; test/crosscheck.test.ts: two agreeing answers meet quorum2 (two real reads of testnet.zec.rocks with port alias, SAME operator) plus dead endpoint -> paid, crossCheck.agreed true, failed endpoint excluded; agreeing refusals remain refused. This proves quorum arithmetic, NOT operator independence. Actual two-indexer test ran too: Zaino HTTP503 -> unverified. Log audit/cli-chain/sdk.txt.')
proof('CLI-018',[('sdk','a server that does not return the transaction disagrees'),('sdk','an endpoint whose answer contradicts itself is a dissent')],
 'Command: python3 audit/cli-chain/run.py sdk; crosscheck.test.ts real testnet payment versus mainnet TX_NOT_FOUND at quorum1 and2 -> UNVERIFIED_DISAGREEMENT, no paid result/report. hardening.test.ts pairs a real fetched record with the exact inconsistent-block error tested by core, rule -> named dissent/unverified. No mock RPC. Logs audit/cli-chain/sdk.txt and core.txt. Source crossCheckVerdict returns report:null/paidZat:0 for disagreement.')
for id,tx,pool in [('CHAIN-013','4a9412fa…8634','Sapling'),('CHAIN-014','6a508fd3…5126','Ironwood')]:
 proof(id,[('core','transparent_inputs_are_signed_over_with_their_previous_outputs_and_sapling_proofs_are_checked')],
 f'Command: python3 audit/cli-chain/run.py core; tests/auth.rs transparent_inputs_are_signed_over_with_their_previous_outputs_and_sapling_proofs_are_checked iterates recorded {tx} {pool} shielding. Actual fetched transparent previous outputs authorize; missing or +1 zat prevout fails AuthError::Invalid. Sapling uses actual published parameters. Log audit/cli-chain/core.txt.')
proof('EDGE-027',[('core','real_payments_pass_and_a_payment_with_one_value_altered_and_reencrypted_is_refused'),('core','a_changed_proof_or_binding_signature_keeps_the_txid_and_is_refused')],
 'Command: python3 audit/cli-chain/run.py core; tests/auth.rs: locally re-encrypted 10x note would pass amount rules but fails authorization; changed proof byte and substituted real binding signature preserve txid and fail authorization. All three additionally assert authorized() error starts lightwalletd answered inconsistently. Only copies of actual fetched transaction bytes modified; no transaction created on chain/submitted. Log audit/cli-chain/core.txt.')
proof('EDGE-028',[('core','recorded_transaction_bytes_cannot_be_swapped_for_another_requested_txid'),('core','an_answer_whose_block_does_not_list_the_tx_is_inconsistent')],
 'Command: python3 audit/cli-chain/run.py core; src/lib.rs live unit test fetches both published x402/auction tx bytes and passes each to the SAME private parse_transaction routine used by inspect and prevouts: own id accepted; other requested id returns exact lightwalletd returned a transaction whose txid differs from the one requested. tests/live.rs removes tx from real compact block or changes requested height: mapped error starts lightwalletd answered inconsistently, never paid. Log audit/cli-chain/core.txt.',
 )
proof('EDGE-030',[('core','plaintext_http_to_a_remote_host_is_refused_before_any_connection'),('core','plaintext_http_to_loopback_is_allowed'),('core','zpv_allow_insecure_lwd_lets_a_remote_plaintext_url_through'),('sdk','a plaintext URL to a remote host is a setup problem')],
 'Commands: python3 audit/cli-chain/run.py core and sdk. core tests/cli.rs: remote plaintext refused before connection (<3s), exit2; loopback attempts permitted; explicit ZPV_ALLOW_INSECURE_LWD=1 permits remote plaintext attempt. SDK hardening classifies remote policy rejection SetupRequiredError. Logs audit/cli-chain/core.txt, sdk.txt.')
proof('EDGE-031',[('core','a_real_socks5_proxy_carries_the_check_and_resolves_the_name'),('core','socks5_without_h_resolves_here_and_sends_an_address'),('core','a_dead_proxy_fails_loudly_and_is_never_bypassed'),('core','a_proxy_url_that_is_not_socks5_is_a_setup_error')],
 'Command: python3 audit/cli-chain/run.py core; tests/transport.rs real SOCKS proxy forwards to actual testnet.zec.rocks: socks5h gives hostname to proxy; socks5 gives locally resolved address. tests/cli.rs dead proxy exits2/empty stdout, no direct fallback; non-SOCKS URL exits2 Setup required: ZPV_LWD_PROXY. Log audit/cli-chain/core.txt.')
proof('EDGE-033',[('sdk','at most ZPV_MAX_CHECKS binaries run at once'),('sdk','at most ZPV_MAX_NULL402_CHECKS Fuji checks run at once'),('sdk','a limiter of its own does not share slots')],
 'Command: python3 audit/cli-chain/run.py sdk; test/hardening.test.ts: 40 actual binary checks at real silent socket, max3/queue5 -> peak <=3, 32 BusyErrors and8 transport failures; 3 live Fuji checks max1/queue0 -> one valid result/two BusyErrors; independently instantiated limiter has own slots. Log audit/cli-chain/sdk.txt.')
proof('EDGE-034',[('sdk','a non-integer or negative amount, a bad minConf or memo'),('sdk','bad input and a missing binary are errors'),('sdk','a non-settle tx or malformed signals are errors'),('sdk','expected values and signals that are not decimal uint256'),('sdk','ZPV_LWD_PROXY reaches the binary')],
 'Command: python3 audit/cli-chain/run.py sdk; hardening.test.ts invalid Zcash amount/minConf/memo/rail/non-object => VerifyError; verify.test.ts invalid null402 signals/proof/expectations => VerifyError, missing binary => SetupRequiredError; real dead proxy retains LightwalletdUnreachableError. No malformed request is a paid verdict. Logs audit/cli-chain/sdk.txt; additional bad-input CLI/ownership checks in audit.txt.')
setrow('CLI-013','UNTESTED','Source packages/core/src/lib.rs:uivk_from_ufvk decodes testnet full viewing credential, converts to incoming-only and encodes; main.rs derive prints result. Dependency: successful path requires prohibited UFVK access and incoming-key output. No successful derive executed; no credential read.')
setrow('CHAIN-018','UNTESTED','Dependency: NULL402_OPERATOR_KEY to register a new root for a valid unspent null402 proof. User explicitly requires UNTESTED. No credential sought/read, root registered or transaction submitted.')
setrow('EDGE-037','UNTESTED','Dependency: recorded pending or reverted null402 settle() transaction. Published deployment and SDK recorded settlement hashes contain successful receipts only. Existing sdk verify.test.ts pending/reverted rule test passed, but it is not a real recorded pending/reverted receipt and does not satisfy this row.')
setrow('EDGE-039','UNTESTED','Dependency: page console/pageerror/request/HTTP evidence from the task owning browser flows. This task prohibits Chrome, Playwright, dashboard and heavy slot. No page flow exercised; core/SDK logs cannot prove browser console cleanliness.')
# Documentation audit: only read repository source, never execute either example entry point.
readme=(ROOT/'README.md').read_text(); testing=(ROOT/'TESTING.md').read_text(); reference=(ROOT/'packages/landing/reference.html').read_text()
examples=json.loads((ROOT/'packages/examples/package.json').read_text())
run_source=(ROOT/'packages/examples/src/run.ts').read_text(); live_source=(ROOT/'packages/examples/src/paywall-live.ts').read_text(); zingo=(ROOT/'packages/examples/src/zingo.ts').read_text()
assert examples['scripts']['run-live']=='tsx src/run.ts'
assert examples['scripts']['paywall-live']=='tsx src/paywall-live.ts'
assert 'quicksend(cfg' in run_source and 'quicksend(cfg' in live_source and "['quicksend', json]" in zingo
assert 'Live runs (not part of `pnpm test`)' in testing
assert 'makes new transactions' in testing
assert all('run-live' in s and 'paywall-live' in s for s in [readme,testing,reference])
record=json.loads((ROOT/'deployments/testnet.json').read_text())
fixtures=json.loads((ROOT/'fixtures/testnet.json').read_text())
for tx in [record['paywallLive']['txid'],record['paywall']['cases']['paywall']['txid'],record['payslip']['txid'],fixtures['x402']['txid'],record['fundTx'],record['thirdParty']['null402']['settleTx']]:
 assert tx in readme and tx in reference,tx
assert 'No contracts are deployed by this project' in reference
# Five-note funding is a documented claim whose exact receiver evidence is absent; preserve the dependency.
lines=[
 'README/reference recorded txid links match deployments/testnet.json and fixtures/testnet.json.',
 'Both examples scripts route to transaction-sending quicksend paths. Never executed in this audit.',
 'TESTING.md explicitly separates those sends from pnpm test. No new-send script used as prerequisite.',
 'Historical 104-test/49-chain counts are documented Oct23 results; this scoped audit does not claim to rerun all gateway/MCP/browser tests.',
 'Dependency: published payer incoming viewing credential for five-note funding claim; see CHAIN-012. Full docs-evidence match cannot be PASS with that missing evidence.',
]
(ROOT/'audit/cli-chain/documentation.txt').write_text('\n'.join(lines)+'\n')
setrow('EDGE-040','UNTESTED','Command: python3 audit/cli-chain/finalize.py; source assertions verify README/reference recorded txid links and TESTING safety split. Both examples call quicksend (transaction-sending) and were NEVER executed; no send script used as prerequisite. Dependency for full claims/evidence match: published payer incoming viewing credential for README five-note funding claim (CHAIN-012); no credential sought. Historical full-suite totals are not claimed as this scoped run. Log audit/cli-chain/documentation.txt.')
print(json.dumps({s:sum(r['status']==s for r in rows) for s in ['PASS','FAIL','UNTESTED','PENDING']}))

"""Map only this phase's fresh assertions onto the unchanged AUDIT.md contract."""
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import hashlib, json, re, subprocess
ROOT = Path(__file__).resolve().parents[2]
LOG = ROOT / 'audit/reverify-backend'
OUT = ROOT / 'audit/status/reverify-backend.json'
# Rebuild from the contract so a repeated finalization cannot inherit a prior PASS.
rows=[]
for line in (ROOT/'AUDIT.md').read_text().splitlines():
    m=re.match(r'\| ((?:API|CHAIN|CLI|MCP|EDGE)-\d{3}) \| (.*?) \| (.*?) \| PENDING \|',line)
    if m and (not m[1].startswith('EDGE-') or 25<=int(m[1][-3:])<=40):
        rows.append(dict(id=m[1],component=m[2],expected=m[3],status='PENDING',evidence=[],fix=''))
by_id = {r['id']: r for r in rows}
logs = {name: (LOG / filename).read_text() for name, filename in [('core','core.txt'),('sdk','sdk.txt'),('gateway','suite.txt'),('mcp','mcp.txt'),('http','http.txt')]}
now = datetime.now(timezone.utc).isoformat()

def update(id, state, detail, files, checks=None):
    row = by_id[id]
    row.update(status=state, detail=detail, evidence=files, fix='')
    if checks is not None: row['checks'] = checks

def passed(log, fragment):
    return any(fragment in line and ('... ok' in line or '✓ test/' in line) for line in logs[log].splitlines())

def proof(id, checks, detail):
    files = list(dict.fromkeys('audit/reverify-backend/' + ('suite.txt' if log=='gateway' else log+'.txt') for log, _ in checks))
    missing = [(log, fragment) for log, fragment in checks if not passed(log, fragment)]
    update(id, 'FAIL' if missing else 'PASS', detail + (f'; missing passing assertions: {missing}' if missing else ''), files, [{'suite':log,'test':fragment,'passed':passed(log,fragment)} for log,fragment in checks])

# Audit tests write these row states as they execute, retaining explicit evidence gaps.
for filename in ['gateway-status.json','mcp-status.json','cli-chain-status.json']:
    for entry in json.loads((LOG/filename).read_text()):
        if entry['status'] == 'PENDING': continue
        id = entry['id']
        detail = entry['evidence']
        if isinstance(detail, list): detail = '; '.join(detail)
        if id.startswith(('API-','MCP-')):
            files = [f'audit/reverify-backend/{id}.json', 'audit/reverify-backend/http.txt' if id.startswith('API-') else 'audit/reverify-backend/mcp.txt']
        else: files = ['audit/reverify-backend/sdk.txt']
        update(id,entry['status'],detail,files)

proof('CLI-016', [('sdk','two agreeing answers meet a quorum of 2'),('sdk','agreeing refusals stay refusals'),('sdk','the two public testnet indexers:')], 'Fresh real endpoint answers test paid/refused quorum arithmetic and exclusion of dead endpoints. Port aliases are two reads from the SAME operator, not independent operators. Separate public-indexer test returns paid only if both agree, otherwise unverified.')
proof('CLI-018', [('sdk','a server that does not return the transaction disagrees'),('sdk','an endpoint whose answer contradicts itself is a dissent')], 'Actual testnet payment versus mainnet absent transaction at quorum 1/2 produces UNVERIFIED_DISAGREEMENT with no paid result. The local rule test also names a self-inconsistent endpoint as dissent, using the error exercised by core.')
for id in ['CHAIN-013','CHAIN-014']:
    proof(id,[('core','transparent_inputs_are_signed_over_with_their_previous_outputs_and_sapling_proofs_are_checked')], 'Fresh recorded Sapling and Ironwood shielding authorization uses actual fetched transparent previous outputs; missing or one-zatoshi-altered previous output fails authorization. Published Sapling parameters are used.')
proof('EDGE-027',[('core','real_payments_pass_and_a_payment_with_one_value_altered_and_reencrypted_is_refused'),('core','a_changed_proof_or_binding_signature_keeps_the_txid_and_is_refused')], 'Recorded bytes are copied locally and the re-encrypted 10x note, proof-byte alteration, and substituted binding signature fail authorization with the inconsistent-lightwalletd diagnostic. No chain transaction is created or sent.')
proof('EDGE-028',[('core','recorded_transaction_bytes_cannot_be_swapped_for_another_requested_txid'),('core','an_answer_whose_block_does_not_list_the_tx_is_inconsistent')], 'Fresh actual transaction bytes run through the production txid parser. Swapped txid, missing inclusion and wrong compact-block height produce the required errors and no paid answer.')
proof('EDGE-030',[('core','plaintext_http_to_a_remote_host_is_refused_before_any_connection'),('core','plaintext_http_to_loopback_is_allowed'),('core','zpv_allow_insecure_lwd_lets_a_remote_plaintext_url_through'),('sdk','a plaintext URL to a remote host is a setup problem')], 'CLI exit 2/Setup required blocks remote plaintext before connecting, loopback is allowed, and the explicit insecure override permits the configured remote connection attempt.')
proof('EDGE-031',[('core','a_real_socks5_proxy_carries_the_check_and_resolves_the_name'),('core','socks5_without_h_resolves_here_and_sends_an_address'),('core','a_dead_proxy_fails_loudly_and_is_never_bypassed'),('core','a_proxy_url_that_is_not_socks5_is_a_setup_error')], 'Real SOCKS forwarding carries actual chain reads: socks5h sends hostname, socks5 resolves locally, dead proxy exits 2 without direct fallback, and non-SOCKS configuration is Setup required.')
proof('EDGE-033',[('sdk','at most ZPV_MAX_CHECKS binaries run at once'),('sdk','at most ZPV_MAX_NULL402_CHECKS Fuji checks run at once'),('sdk','a limiter of its own does not share slots')], 'Fresh tests enforce Zcash 3 active/5 queued across 40 calls (32 BusyErrors), Fuji 1 active/0 queued across 3 calls (2 BusyErrors), and independent limiter capacity.')
proof('EDGE-034',[('sdk','a non-integer or negative amount, a bad minConf or memo'),('sdk','bad input and a missing binary are errors'),('sdk','a non-settle tx or malformed signals are errors'),('sdk','expected values and signals that are not decimal uint256'),('sdk','ZPV_LWD_PROXY reaches the binary')], 'Fresh invalid rail/value tests reject with VerifyError; missing binary yields SetupRequiredError; real transport failure keeps LightwalletdUnreachableError. No invalid input is paid.')

# Preserve the resolved environment failure and exact public-client provenance.
if by_id['API-037']['status']=='PASS':
    by_id['API-037']['resolvedDependency']='Configured the actual public Shielded x402 client at pinned revision 50acc85850aabfde02e6ad334e8cd67eebab8708 in an isolated temporary checkout; full gateway suite rerun passed.'
    by_id['API-037']['evidence'] += ['audit/reverify-backend/kage-dependency.json','audit/reverify-backend/suite.txt','audit/reverify-backend/suite-initial-missing-kage.txt']

# Cross-component cell requires BOTH fresh SDK and MCP evidence, not the earlier phase's status.
sdk_second = passed('sdk','CHAIN-016 second Fuji settlement SDK path')
mcp_second = json.loads((LOG/'MCP-013.json').read_text())
second_hash = '0xd91c0ab7d0d228d003277d62145442b24dcd52492becf561b9977c40fe781e5c'
second = [e for e in mcp_second.get('evidence',[]) if e.get('request',{}).get('arguments',{}).get('settle_tx')==second_hash]
# The public schema uses tx_hash in some versions; match the concrete requested hash regardless of field name.
if not second: second = [e for e in mcp_second.get('evidence',[]) if second_hash in e.get('request',{}).get('arguments',{}).values()]
confirmed = sdk_second and mcp_second['status']=='PASS' and any(e['response']['result'].get('ok') is True and e['response']['result'].get('verdict')=='paid' and e['response']['result'].get('settled') is True for e in second)
update('CHAIN-016','PASS' if confirmed else 'FAIL','SDK and real stdio MCP both freshly verify recorded settlement at block 57020809 with matching payTo/amount/recipient as paid and settled.', ['audit/reverify-backend/sdk.txt','audit/reverify-backend/MCP-013.json','audit/reverify-backend/mcp.txt'])

update('CLI-013','UNTESTED','Successful derive requires prohibited UFVK access and incoming-key output. Source contract reviewed; only absent/malformed synthetic paths run under CLI-012. No successful derive executed.', ['audit/reverify-backend/documentation.json','audit/reverify-backend/sdk.txt'])
update('CHAIN-018','UNTESTED','Explicit user restriction: a valid unspent new-root proof requires operator authorization and root registration. No operator credential sought and no root registered or transaction submitted.', ['audit/reverify-backend/documentation.json'])
update('EDGE-037','UNTESTED','Both published recorded settlements have successful receipts. A real pending/reverted settle receipt is unavailable; the freshly passing rule-only SDK test does not satisfy this row. No receipt fabricated or transaction submitted.', ['audit/reverify-backend/sdk.txt','audit/reverify-backend/MCP-013.json'])
update('EDGE-039','UNTESTED','This is a browser console/pageerror/network gate. Browser execution is prohibited in this backend task; no page flow exercised. Fresh backend logs cannot prove browser cleanliness and earlier page evidence is not substituted.', ['audit/reverify-backend/documentation.json'])
update('EDGE-040','UNTESTED','Fresh documentation safety checks identify both transaction-sending examples and verify they are outside tests; neither executed. Full documentation/evidence match still depends on the absent published funding receiver credential (CHAIN-012). Historical 104/49 baseline is not this expanded rerun total.', ['audit/reverify-backend/documentation.json','audit/reverify-backend/sdk.txt'])

# Every expected cell remains byte-for-byte the unchanged contract.
contract = {}
for line in (ROOT/'AUDIT.md').read_text().splitlines():
    match = re.match(r'\| ((?:API|CHAIN|CLI|MCP|EDGE)-\d{3}) \| (.*?) \| (.*?) \| PENDING \|',line)
    if match and match[1] in by_id: contract[match[1]]=match[3]
assert len(rows)==len(contract)==136
assert all(r['expected']==contract[r['id']] for r in rows)
assert all(r['status'] in ['PASS','FAIL','UNTESTED'] for r in rows)
assert by_id['CHAIN-018']['status']=='UNTESTED'
for row in rows:
    assert row['evidence'] and all((ROOT/name).is_file() for name in row['evidence'])
    if not row['id'].startswith(('API-','MCP-')):
        path = LOG/(row['id']+'.json')
        matching = [line for name in ['sdk','core'] for line in logs[name].splitlines() if (row['id'] in line or any(c['test'] in line for c in row.get('checks',[]) if c['suite']==name)) and ('AUDIT ' in line or '✓ test/' in line or '... ok' in line)]
        path.write_text(json.dumps({'id':row['id'],'mappedAt':now,'status':row['status'],'expected':row['expected'],'detail':row['detail'],'checks':row.get('checks',[]),'evidence':row['evidence'],'passingLogLines':matching},indent=2)+'\n')
        row['evidence'] = [str(path.relative_to(ROOT))]+row['evidence']
    row['phase']=4
OUT.write_text(json.dumps(rows,indent=2)+'\n')
counts=dict(Counter(r['status'] for r in rows))
summary={'at':now,'rows':counts,'byComponent':{prefix:dict(Counter(r['status'] for r in rows if r['id'].startswith(prefix+'-'))) for prefix in ['API','CHAIN','CLI','MCP','EDGE']}, 'untested':{r['id']:r['detail'] for r in rows if r['status']=='UNTESTED'}, 'failures':{r['id']:r['detail'] for r in rows if r['status']=='FAIL'},'transactionsSent':0,'commitPolicy':'Authoritative Loom session forbids commits; changes left for Loom to commit and merge.','pushed':False}
(LOG/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))

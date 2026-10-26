import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const dir='audit/reverify-console',rows=JSON.parse(await readFile('audit/status/reverify-console.json','utf8')),session=JSON.parse(await readFile(`${dir}/session.json`,'utf8'));
const ids=[...Array.from({length:20},(_,i)=>`PAGE-${String(i+21).padStart(3,'0')}`),...Array.from({length:12},(_,i)=>`EDGE-${String(i+1).padStart(3,'0')}`),...['015','017','020','021','022','023','024'].map(x=>`EDGE-${x}`)];
assert.deepEqual(rows.map(r=>r.id),ids);assert(rows.every(r=>['PASS','FAIL','UNTESTED'].includes(r.status)));
assert.equal(spawnSync('git',['diff','--quiet','--','AUDIT.md']).status,0,'AUDIT.md unchanged');
let shots=0,maxImage=0,assertions=0,maxDuration=0;const evidence=new Set(),methods=new Set(),pids=[];
for(const row of rows){
 assert.equal(row.evidence.filter(x=>/\.(jpg|jpeg|webp|png)$/.test(x)).length,1,`${row.id} exactly one new screenshot`);
 assert(row.expected);assert(row.evidence.length>0,`${row.id} evidence exists`);
 for(const file of row.evidence){const meta=await stat(file);assert(meta.mtimeMs>=Date.parse(session.started),`${file} fresh`);if(file.endsWith('.jpg')){shots++;maxImage=Math.max(maxImage,meta.size);assert(meta.size<=200000,`${file} <=200KB`);}else if(file.endsWith('.json'))evidence.add(file);}
}
for(const file of evidence){
 const text=await readFile(file,'utf8'),ev=JSON.parse(text);assert(!/u(?:ivk|fvk|view)(?:test)?1[a-z0-9]{30,}/i.test(text),`${file} no full viewing key`);assert(Date.parse(ev.at)>=Date.parse(session.started));assertions+=ev.checks.length;
 assert(ev.durationMs>0&&ev.durationMs<90000,`${file} row under 90s`);maxDuration=Math.max(maxDuration,ev.durationMs);
 if(ev.status==='PASS'){assert.equal(ev.errors.length,0);for(const a of Object.values(ev.unexpected??ev.failures??{}))assert.equal(a.length,0,`${file} unexpected error`);}
 for(const req of ev.requests??[])for(const method of req.rpcMethods??[])methods.add(method);
}
assert([...methods].every(x=>['eth_chainId','eth_blockNumber','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getBlockByNumber','eth_call'].includes(x)),'only read-only Fuji RPC methods');
for(const file of (await readdir(dir)).filter(x=>x==='session.json'||/-session-.*\.json$/.test(x))){const manifest=JSON.parse(await readFile(`${dir}/${file}`,'utf8'));if(Date.parse(manifest.started)<Date.parse(session.started))continue;for(const p of manifest.processes){assert(p.exited,`${p.name??p.label} ${p.pid} exited`);pids.push({file,...p});}}
async function bytes(path){let size=0;for(const d of await readdir(path,{withFileTypes:true})){const f=`${path}/${d.name}`;size+=d.isDirectory()?await bytes(f):(await stat(f)).size;}return size;}
let owner='';try{owner=await readFile('/tmp/grokbot-heavy-slots/slot1/owner','utf8');}catch{}assert(!owner.startsWith('audit-t13 '),'audit-t13 heavy slot released');
const auditBytes=await bytes('audit');assert(auditBytes<15000000,'audit/ below 15MB');
const result={validatedAt:new Date().toISOString(),rows:rows.length,totals:Object.fromEntries(['PASS','FAIL','UNTESTED'].map(x=>[x,rows.filter(r=>r.status===x).length])),assertions,screenshots:shots,maxScreenshotBytes:maxImage,maxRowDurationMs:maxDuration,auditBytes,readOnlyFujiMethods:[...methods],allRecordedProcessesExited:true,heavySlotReleased:true,processes:pids,auditMdUnchanged:true,fullViewingKeysRedacted:true};
await writeFile(`${dir}/validation.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));

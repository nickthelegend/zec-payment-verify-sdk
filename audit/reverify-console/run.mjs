// Complete fresh Phase 4 run; all app calls are read-only, with no response stubs.
import {spawn} from 'node:child_process';
import {readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
const dir='audit/reverify-console',slot='/Volumes/Extreme SSD/Projects/grokbot/tools/heavy-slot.sh';
const manifest={started:new Date().toISOString(),runnerPid:process.pid,video:false,trace:false,rowTimeoutMs:90000,processes:[]};
const clean=s=>String(s).replace(/u(?:ivk|fvk|view)(?:test)?1[a-z0-9…]+/gi,'[REDACTED]');
async function command(name,cmd,args,extra={}){
 const p=spawn(cmd,args,{stdio:['ignore','pipe','pipe'],...extra});const item={name,pid:p.pid};manifest.processes.push(item);let output='';
 p.stdout.on('data',d=>{output+=d;process.stdout.write(clean(d));});p.stderr.on('data',d=>{output+=d;process.stderr.write(clean(d));});
 const result=await new Promise((res,rej)=>{p.once('exit',(code,signal)=>{Object.assign(item,{exited:true,code,signal});res(code);});p.once('error',rej);});
 await writeFile(`${dir}/${name}.txt`,clean(output).trimEnd()+'\n');return result;
}
async function aggregate(){
 const rows=[];const expected=Object.fromEntries((await readFile('AUDIT.md','utf8')).split('\n').filter(x=>/^\| (PAGE-|EDGE-)/.test(x)).map(x=>{const cells=x.split('|');return [cells[1].trim(),cells[3].trim()];}));
 for(const [name,surface] of [['console','console'],['pages','pages'],['edges','edges']]){
  let result=[];try{result=JSON.parse(await readFile(`${dir}/${name}-status.json`,'utf8'));}catch{}
  for(const entry of result){
   let row=rows.find(x=>x.id===entry.id);if(!row){row={id:entry.id,expected:expected[entry.id],status:'PASS',surfaces:{},evidence:[],fix:''};rows.push(row);}
   const evPath=entry.evidence.at(-1);let ev={};if(evPath)ev=JSON.parse(await readFile(evPath,'utf8'));
   if(entry.status!=='PASS')row.status=entry.status==='FAIL'?'FAIL':(row.status==='FAIL'?'FAIL':'UNTESTED');
   Object.assign(row.surfaces,entry.surfaces??{[surface]:entry.status});
   if(evPath)row.evidence.push(evPath,...(ev.screenshots??[]));
   row.executions??=[];row.executions.push({surface,at:ev.at,durationMs:ev.durationMs??(ev.finished?Date.parse(ev.finished)-Date.parse(ev.at):undefined)});
   if(entry.id==='EDGE-024'&&entry.status==='UNTESTED')row.dependency='needs testnet.snowtrace.io to serve the recorded settlement to headless Chrome without a Cloudflare challenge; the rendered href is the published hash.';
  }
 }
 const ids=[...Array.from({length:20},(_,i)=>`PAGE-${String(i+21).padStart(3,'0')}`),...Array.from({length:12},(_,i)=>`EDGE-${String(i+1).padStart(3,'0')}`),...['015','017','020','021','022','023','024'].map(x=>`EDGE-${x}`)];
 const final=ids.map(id=>rows.find(x=>x.id===id)??{id,expected:expected[id],status:'UNTESTED',evidence:[],blocker:'Run did not reach this row.'});
 await writeFile('audit/status/reverify-console.json',JSON.stringify(final,null,2)+'\n');return final;
}
let config;
try{
 if(process.env.HANKO_HEAVY_SLOT_HELD==='1'){
  const owner=await readFile('/tmp/grokbot-heavy-slots/slot1/owner','utf8');if(!owner.startsWith('audit-t13 '))throw Error('audit-t13 slot is not held');manifest.slotOwner=owner.trim();
 }else if(await command('slot-acquire',slot,['acquire','audit-t13']))throw Error('Slot acquire failed');
 for(const name of ['sdk','gateway'])if(await command(`${name}-build`,'pnpm',['--filter',`@zpv/${name}`,'build']))throw Error(`${name} build failed`);
 if(await command('dashboard-types',process.execPath,['packages/dashboard/node_modules/typescript/bin/tsc','--noEmit','-p','packages/dashboard/tsconfig.json']))throw Error('dashboard typecheck failed');
 config=resolve('packages/dashboard/.reverify-pages.config.mjs');await writeFile(config,"import base from './vite.config.ts';\nexport default {...base,envDir:false};\n");
 if(await command('pages-build','bash',['-c','node() { command node "$@" --config "$HANKO_AUDIT_VITE_CONFIG"; }; export -f node; bash scripts/build-pages.sh site'],{env:{...process.env,HANKO_AUDIT_VITE_CONFIG:config}}))throw Error('Pages build failed');
 await rm(config);config=null;await symlink('.','site/zec-payment-verify-sdk');
 for(const part of ['console','pages','edges'])await command(`${part}-run`,process.execPath,[`${dir}/${part}.mjs`]);
}finally{
 if(config)await rm(config,{force:true});const rows=await aggregate();manifest.finished=new Date().toISOString();manifest.totals=Object.fromEntries(['PASS','FAIL','UNTESTED'].map(status=>[status,rows.filter(r=>r.status===status).length]));
 await command('slot-release',slot,['release','audit-t13']);await writeFile(`${dir}/session.json`,JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest.totals));process.exitCode=rows.some(r=>r.status!=='PASS')?1:0;
}

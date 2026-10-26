import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, rm, stat, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {X509Certificate,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../../e2e/package.json',import.meta.url));
const {chromium,expect}=require('@playwright/test');
const dir='audit/reverify-console', statusFile='audit/reverify-console/edges-status.json';
const ids=[...Array.from({length:12},(_,i)=>`EDGE-${String(i+1).padStart(3,'0')}`),'EDGE-015','EDGE-017','EDGE-020','EDGE-021','EDGE-022','EDGE-023','EDGE-024'];
const selected=process.argv.slice(2).length?process.argv.slice(2):ids;
assert(selected.every(x=>ids.includes(x)));
const api='https://hanko-api.201-18-198-162.sslip.io', closed='http://127.0.0.1:18403';
const urls={hosted:'https://hanko-dashboard-six.vercel.app',local:'http://localhost:5187',down:'http://localhost:5188',landing:'http://127.0.0.1:5197',reference:'http://127.0.0.1:5197/reference.html',liveLanding:'https://hanko-landing-six.vercel.app/',liveReference:'https://hanko-landing-six.vercel.app/reference.html',pagesLanding:'http://127.0.0.1:5198/',pagesReference:'http://127.0.0.1:5198/reference.html',pagesConsole:'http://127.0.0.1:5198/dashboard/'};
const clean=s=>String(s).replace(/u(?:ivk|fvk|view)(?:test)?1[a-z0-9…]+/gi,'[redacted-viewing-key]').slice(0,1800);
let rows=ids.map(id=>({id,status:'PENDING',evidence:[],fix:''}));
if(selected.length!==ids.length)try{rows=JSON.parse(await readFile(statusFile,'utf8'));}catch{}
const persist=()=>writeFile(statusFile,JSON.stringify(rows,null,2)+'\n');
await mkdir(dir,{recursive:true}); await persist();
const manifest={started:new Date().toISOString(),runnerPid:process.pid,channel:'chrome',headless:true,video:false,trace:false,rowTimeoutMs:90000,urls,processes:[],notes:['Real verify-only API, real binary and real lightwalletd. No paywall, fabricated API/chain responses, transaction signing or submission. Only transport faults/delays are injected.','A temporary local TLS certificate is trusted only by its SPKI hash; Chrome local-network-access permission is granted to the hosted origin for real loopback API failure cases.',
'Timeout advances Chrome virtual time beyond the production 90-second timer, within the 90-second wall-clock row budget.']};
const sessionFile=`${dir}/edges-session-${process.pid}.json`;
const saveSession=()=>writeFile(sessionFile,JSON.stringify(manifest,null,2)+'\n');
const children=[],configs=[];
function track(label,p){children.push(p);const item={label,pid:p.pid};manifest.processes.push(item);p.once('exit',(code,signal)=>Object.assign(item,{exited:true,code,signal}));return p;}
async function stop(p){if(!p||p.exitCode!==null||p.signalCode!==null)return;try{process.kill(p.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}await Promise.race([new Promise(r=>p.once('exit',r)),new Promise(r=>setTimeout(r,1200))]);if(p.exitCode===null&&p.signalCode===null)try{process.kill(p.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
let browser,chrome,tlsDir;
try{
 const slotOwner=await readFile('/tmp/grokbot-heavy-slots/slot1/owner','utf8');assert(slotOwner.startsWith('audit-t13 '),'audit-t13 heavy slot must be held');manifest.slotOwner=slotOwner.trim();
 await new Promise((res,rej)=>{const s=net.connect(18403,'127.0.0.1');s.once('connect',()=>{s.destroy();rej(Error('Closed port unexpectedly listening'));});s.once('error',e=>e.code==='ECONNREFUSED'?res():rej(e));});manifest.closedPortVerified=true;
 for(const [port,target] of [[5187,api],[5188,closed]]){
  const config=resolve(`packages/dashboard/.reverify-edges-${port}.config.mjs`);configs.push(config);
  await writeFile(config,`import base from './vite.config.ts';\nimport react from '@vitejs/plugin-react';\nexport default {...base,envDir:false,plugins:[react()],resolve:{alias:{'@fixtures':${JSON.stringify(resolve('fixtures'))}}},define:{'import.meta.env.VITE_ZPV_API':${port===5187?'undefined':JSON.stringify(JSON.stringify(target))},'import.meta.env.VITE_ZPV_PROXY_API':${port===5187?JSON.stringify(JSON.stringify(api)):'undefined'},'import.meta.env.VITE_ZPV_PAGES':'undefined'},server:{...base.server,host:'localhost',port:${port},strictPort:true,fs:{allow:[${JSON.stringify(process.cwd())}]}}};\n`);
  const p=track(`dashboard ${port}`,spawn(process.execPath,['packages/dashboard/node_modules/vite/bin/vite.js','packages/dashboard','--config',config],{env:{...process.env,VITE_ZPV_PROXY_API:port===5187?api:''},stdio:['ignore','pipe','pipe']}));
  await Promise.race([new Promise((res,rej)=>{p.stdout.on('data',d=>{if(d.toString().includes(`localhost:${port}`))res();});p.once('exit',c=>rej(Error(`Vite exit ${c}`)));}),new Promise((_,rej)=>setTimeout(()=>rej(Error('Vite startup timeout')),15000))]);
 }
 const srv=track('landing/reference static',spawn(process.execPath,['e2e/serve-static.mjs','5197:packages/landing','5198:site'],{stdio:['ignore','pipe','pipe']}));await new Promise(r=>srv.stdout.once('data',r));
 const verifier='/Volumes/Extreme SSD/Projects/grokbot/projects/zec-payment-verify-sdk/packages/core/target/release/zpay-verify';
 manifest.verifierBinary={path:verifier,sha256:createHash('sha256').update(await readFile(verifier)).digest('hex'),note:'Pre-existing release verifier; the SDK and gateway are built from this worktree.'};
 for(const [port,extra] of [[18404,{ZPV_LWD_URL:'https://127.0.0.1:18403'}],[18405,{ZPV_BIN:'/tmp/hanko-audit-t13-no-such-verifier'}],[18406,{ZPV_LWD_URLS:'https://testnet.zec.rocks:443,https://127.0.0.1:18403',ZPV_LWD_QUORUM:'2'}]]){
  const env={...process.env,ZPV_BIN:verifier,ZPV_LWD_URL:'',ZPV_LWD_URLS:'',ZPV_LWD_QUORUM:'',ZPV_LWD_PROXY:'',ZPV_PORT:String(port),ZPV_CORS:'https://hanko-dashboard-six.vercel.app,http://localhost:5187',...extra};
  const p=track(`verify-only API ${port}`,spawn(process.execPath,['packages/gateway/dist/api.js'],{env,stdio:['ignore','pipe','pipe']}));let err='';p.stderr.on('data',d=>err+=clean(d));await Promise.race([new Promise((res,rej)=>{p.stdout.once('data',res);p.once('exit',c=>rej(Error(`API exit ${c}: ${err}`)));}),new Promise((_,rej)=>setTimeout(()=>rej(Error('API start deadline')),10000))]);
 }
 tlsDir=await mkdtemp(`${tmpdir()}/hanko-t13-tls-`);
 const cert=track('temporary local TLS certificate',spawn('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${tlsDir}/key.pem`,'-out',`${tlsDir}/cert.pem`,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'}));await new Promise((res,rej)=>{cert.once('exit',c=>c===0?res():rej(Error('openssl failed')));});
 const certificate=new X509Certificate(await readFile(`${tlsDir}/cert.pem`));const spki=createHash('sha256').update(certificate.publicKey.export({type:'spki',format:'der'})).digest('base64');
 const tls=track('local HTTPS forwarding',spawn(process.execPath,['audit/reverify-console/tls-forward.mjs',`${tlsDir}/key.pem`,`${tlsDir}/cert.pem`],{stdio:['ignore','pipe','pipe']}));await new Promise(r=>tls.stdout.once('data',r));
 chrome=await chromium.launchServer({channel:'chrome',headless:true,args:[`--ignore-certificate-errors-spki-list=${spki}`]});track('Google Chrome',chrome.process());browser=await chromium.connect(chrome.wsEndpoint());manifest.browser=browser.version();await saveSession();console.log(`Chrome ${manifest.browser}; runner ${process.pid}`);
 for(const id of selected){
  const row=rows.find(r=>r.id===id),attempt=row.evidence.length+1;row.status='RUNNING';await persist();
  const ev={id,attempt,at:new Date().toISOString(),browser:manifest.browser,checks:[],console:[],network:[],requests:[],requestFailures:[],pageErrors:[],errors:[],screenshots:[],surfaces:{}};
  let contexts=[],surface,page,context;
  const check=(ok,name,actual)=>{ev.checks.push({surface,name,pass:!!ok,...(actual===undefined?{}:{actual})});assert(ok,name);};
  const observe=p=>{const s=surface;p.on('console',m=>ev.console.push({surface:s,type:m.type(),text:clean(m.text()),url:clean(m.location().url)}));p.on('pageerror',e=>ev.pageErrors.push({surface:s,document:p.url(),message:clean(e.message)}));p.on('request',r=>{const item={surface:s,url:clean(r.url()),method:r.method()};if(r.url().includes('/ext/bc/C/rpc'))try{item.rpcMethods=[].concat(JSON.parse(r.postData())).map(x=>x.method);}catch{}ev.requests.push(item);});p.on('response',r=>ev.network.push({surface:s,url:clean(r.url()),status:r.status(),type:r.request().resourceType()}));p.on('requestfailed',r=>ev.requestFailures.push({surface:s,url:clean(r.url()),error:clean(r.failure()?.errorText)}));};
  const shot=async suffix=>{if(ev.screenshots.length||id==='EDGE-021')return;if(id==='EDGE-020'&&!['unverified','result','failure'].includes(suffix))return;const path=`${dir}/${id}.jpg`;const buf=await page.screenshot({type:'jpeg',quality:20,mask:[page.getByLabel('uivk',{exact:true}),page.locator('.j-s').filter({hasText:/u(?:ivk|fvk|view)(?:test)?1/i})]});check(buf.length<=200000,'screenshot <=200 KB',buf.length);await writeFile(path,buf);ev.screenshots.push(path);};
  const v=()=>page.locator('.verdict'),resp=()=>page.locator('.response'),hist=()=>page.locator('#history .log > li');
  const noSeal=async()=>expect(page.locator('.stamp')).toHaveCount(0);
  const send=async()=>{await page.locator('.send').click();await expect(page.locator('.send')).toHaveText('Send request',{timeout:25000});};
  const rail=async r=>page.getByRole('button',{name:r==='zcash'?/Zcash payment/:/null-402 proof/}).click();
  const redirect=async mode=>{const port={bad:18404,setup:18405,quorum:18406}[mode];ev.checks.push({surface,name:'Original request routed to actual verify-only API',pass:true,actual:{mode,port}});await page.route('**/api/verify',r=>r.continue({url:`${surface==='hosted'?'https':'http'}://127.0.0.1:${port+(surface==='hosted'?1000:0)}/api/verify`}).catch(async e=>{ev.errors.push({surface,message:clean(e.message)});await r.abort().catch(()=>{});}));};
  const live=async(mode='normal')=>{await page.unroute('**/api/verify');if(mode!=='normal')await redirect(mode);await send();return JSON.parse(await resp().locator('pre').innerText());};
  const reset=async()=>{await page.unroute('**/api/verify');await page.reload({waitUntil:'load'});await expect(page.getByRole('status')).not.toContainText('checking');};
  const task=async()=>{
   let surfaces=['hosted','local'];if(id==='EDGE-005')surfaces=['down'];if(id==='EDGE-022')surfaces=['landing','reference','liveLanding','liveReference','pagesLanding','pagesReference','pagesConsole','hosted','local'];if(['EDGE-023','EDGE-024'].includes(id))surfaces=['reference','liveReference','hosted','local','landing','liveLanding'];
   for(surface of surfaces){
    try{
     context=await browser.newContext({viewport:{width:['EDGE-020','EDGE-021'].includes(id)?375:1440,height:['EDGE-020','EDGE-021'].includes(id)?812:900},...(id==='EDGE-015'?{reducedMotion:'reduce'}:{})});contexts.push(context);if(['EDGE-007','EDGE-011','EDGE-015','EDGE-020'].includes(id))await context.grantPermissions(['local-network-access'],{origin:urls[surface]});page=await context.newPage();page.setDefaultTimeout(4500);page.setDefaultNavigationTimeout(18000);observe(page);
     // Health and every API body come from the real running services.
     const nav=await page.goto(urls[surface],{waitUntil:'load'});check(nav?.status()===200,'page HTTP 200',nav?.status());
     if(['hosted','local','down'].includes(surface))await expect(page.getByRole('status')).not.toContainText('checking',{timeout:15000});
     if(id==='EDGE-001'){
      await page.getByLabel('txid',{exact:true}).fill('not-a-txid');await page.locator('.send').click();check(await page.getByLabel('txid',{exact:true}).evaluate(e=>e.validity.patternMismatch),'txid patternMismatch');check(!ev.requests.some(x=>x.surface===surface&&x.method==='POST'&&x.url.endsWith('/api/verify')),'zero verify POST');await expect(v()).toContainText('Nothing checked yet.');await noSeal();
     }
     if(id==='EDGE-002'){
      for(const name of ['uivk','txid','amountZat']){await page.reload();await page.getByLabel(name,{exact:true}).fill('');await page.locator('.send').click();check(await page.getByLabel(name,{exact:true}).evaluate(e=>e.validity.valueMissing),`${name} required blocks submit`);}
      for(const name of ['amountZat','minConf'])for(const value of ['-1','1.5','nope','1e3','0x10']){await page.reload();await page.getByLabel(name,{exact:true}).fill(value);await page.locator('.send').click();check(await page.getByLabel(name,{exact:true}).evaluate(e=>e.validity.patternMismatch),`${name} rejects ${value}`);if(name==='amountZat')await expect(page.locator('.unit')).toHaveText('whole zatoshi');}
      check(!ev.requests.some(x=>x.surface===surface&&x.method==='POST'&&x.url.endsWith('/api/verify')),'zero verify POST');await noSeal();
     }
     if(id==='EDGE-003'){
      await rail('null402');const settle=page.getByLabel('settle_tx',{exact:true});
      for(const value of ['','not-a-hash','0x1234']){await settle.fill(value);await page.locator('.send').click();check(await settle.evaluate(e=>!e.validity.valid),`settle rejects ${value||'empty'}`);}
      await settle.fill('0x'+'ab'.repeat(32));for(const name of ['expect.payTo','expect.requiredAmount'])for(const value of ['-1','1.5','0xab','letters']){await page.getByLabel(name,{exact:true}).fill(value);await page.locator('.send').click();check(await page.getByLabel(name,{exact:true}).evaluate(e=>e.validity.patternMismatch),`${name} rejects ${value}`);await page.getByLabel(name,{exact:true}).fill('');}
      check(!ev.requests.some(x=>x.surface===surface&&x.url.includes('/ext/bc/C/rpc')),'zero Fuji RPC');await noSeal();
     }
     if(id==='EDGE-004'){
      await page.getByLabel('uivk',{exact:true}).fill('bad-viewing-key-encoding');await send();await expect(v()).toContainText('Could not check');await expect(resp().locator('.status')).toHaveText('HTTP 400');const body=JSON.parse(await resp().locator('pre').innerText());check(typeof body.error==='string','400 error JSON',{error:clean(body.error)});await expect(hist().first()).toContainText('Error');await expect(page.getByText('Setup required',{exact:true})).toHaveCount(0);await noSeal();
     }
     if(id==='EDGE-005'){
      await expect(page.getByRole('status')).toHaveText('verify API not reachable');await expect(page.locator('.banner').first()).toContainText('Setup required');const before=ev.requests.filter(x=>x.surface===surface&&x.url.endsWith('/api/health')).length;await page.getByRole('button',{name:'check again',exact:true}).click();await expect(page.getByRole('status')).toHaveText('verify API not reachable');check(ev.requests.filter(x=>x.surface===surface&&x.url.endsWith('/api/health')).length===before+1,'retry exactly one health request');await send();await expect(hist().first()).toContainText('Setup required');await expect(resp().locator('.status')).toHaveText('setup required');await noSeal();await rail('null402');await expect(page.getByRole('status')).toHaveClass(/health-neutral/);await expect(page.getByRole('status')).toHaveText('Fuji, straight from this browser');
     }
     if(id==='EDGE-006'){
      await page.clock.install();await page.route('**/api/verify',()=>{});await page.locator('.send').click();await expect(page.locator('.send')).toHaveText('Checking…');await page.clock.fastForward(90001);await expect(page.locator('.send')).toHaveText('Send request');await expect(v()).toContainText('Could not check');await expect(v()).toContainText(`the verify API at ${surface==='local'?urls.local:api} gave no answer within 90 s`);await expect(hist().first()).toContainText('Error');await noSeal();check(true,'production 90000ms timeout fired after Chrome virtual 90001ms');
     }
     if(id==='EDGE-007')for(const [mode,status] of [['bad',502],['setup',503]]){
      const body=await live(mode); await expect(v()).toContainText(status===502?'Could not check':'Setup required');await expect(resp().locator('.status')).toHaveText(`HTTP ${status}`);check(typeof body.error==='string','real API error JSON preserved',{error:clean(body.error)});await expect(hist().first()).toContainText(status===502?'Error':'Setup required');await noSeal();await shot(String(status));await page.unroute('**/api/verify');
     }
     if(id==='EDGE-008'){
      await rail('null402');await page.getByLabel('settle_tx',{exact:true}).fill('0x'+'ab'.repeat(32));await send();await expect(v()).toContainText('Fuji does not know this transaction');await noSeal();await page.route('**/ext/bc/C/rpc',r=>r.abort('failed'));ev.checks.push({surface,name:'Fuji failure injected by network abort',pass:true});await send();await expect(v()).toContainText('Could not check');await expect(v().locator('[role=alert] p')).toHaveCount(1);check(!(await v().locator('[role=alert] p').innerText()).includes('\n'),'one-line error');await expect(hist().first()).toContainText('Error');await expect(resp().locator('.status')).toHaveText('error');await noSeal();
     }
     if(['EDGE-009','EDGE-010'].includes(id))for(const r of ['zcash','null402']){
      if(r==='null402')await rail(r);const pattern=r==='zcash'?'**/api/verify':'**/ext/bc/C/rpc';let pendingRoute;await page.route(pattern,route=>{pendingRoute=route;});await page.locator('.send').click();await expect(page.locator('.send')).toHaveText('Checking…');await expect.poll(()=>!!pendingRoute).toBe(true);
      if(id==='EDGE-009'){
       await expect(page.locator('fieldset')).toHaveAttribute('disabled','');for(const el of await page.locator('fieldset input,fieldset button,.send').all())await expect(el).toBeDisabled();await expect(v()).toContainText('Checking live…');await expect(resp()).toContainText(`Waiting for ${r==='zcash'?new URL(surface==='local'?urls.local:api).host:'Fuji'}…`);const before=await page.locator('.pane').first().locator('pre').innerText();if(r==='zcash')await page.getByRole('radio').first().evaluate(e=>e.click());check(before===await page.locator('.pane').first().locator('pre').innerText(),'request preview locked');await shot(r);await rail(r==='zcash'?'null402':'zcash');
      }else{
       await rail(r==='zcash'?'null402':'zcash');await expect(page.locator('.send')).toHaveText('Send request');await noSeal();await pendingRoute.continue().catch(()=>{});await page.waitForTimeout(250);await expect(hist()).toHaveCount(0);await expect(v()).not.toContainText('Checking live…');await expect(v().locator('.v-badge')).toHaveCount(0);await rail(r);await expect(hist()).toHaveCount(0);await noSeal();await expect(v().locator('.v-badge')).toHaveCount(0);check(true,`${r} late response discarded after switching away and back`);
      }
      await page.unroute(pattern);if(r==='zcash')await rail('zcash');
     }
     if(id==='EDGE-011'){
      const body=await live('quorum');await expect(v().locator('.v-badge')).toHaveText('Unverified');await expect(page.getByRole('img',{name:'Verdict: unverified',exact:true})).toBeVisible();check(JSON.stringify(await page.locator('.stamp text').allTextContents())===JSON.stringify(['HOLD','NO CONSENSUS']),'HOLD / NO CONSENSUS');await expect(v()).toContainText('UNVERIFIED_QUORUM');await expect(v()).toContainText('No verdict: this payment is neither paid nor refused.');await expect(v().locator('table tbody tr')).toHaveCount(2);check(JSON.parse(await resp().locator('pre').innerText()).report===null,'report null');await expect(v().getByText('Paid',{exact:true})).toHaveCount(0);
     }
     if(id==='EDGE-012'){
      await page.getByLabel('memo',{exact:true}).fill('');await send();await expect(v().locator('.v-badge')).toHaveText('Paid');await expect(v()).toContainText('no memo checked: any earlier payment to this key would also pass');await expect(v().locator('.reasons')).toContainText('NO_MEMO_BOUND');await expect(page.locator('.stamp-note')).toHaveText('NO_MEMO_BOUND');await expect(v()).not.toContainText('with the expected memo');
     }
     if(id==='EDGE-015'){
      for(const [mode,label] of [['normal','PAID'],['refused','UNPAID'],['pending','WAIT'],['quorum','HOLD']]){await page.getByRole('radio',{name:/x402 payment/}).click(); if(mode==='refused')await page.getByRole('radio',{name:/Wrong invoice memo/}).click();if(mode==='pending')await page.getByLabel('minConf',{exact:true}).fill('100000000'); await live(mode==='quorum'?'quorum':'normal');check(await page.locator('.stamp').evaluate(e=>getComputedStyle(e).animationName)==='none','stamp animation none');await expect(page.locator('.stamp text').first()).toHaveText(label);await expect(page.locator('.stamp')).toBeVisible();if(label==='HOLD')await shot('result');await page.unroute('**/api/verify');}
      await page.route('**/api/verify',()=>{});await page.locator('.send').click();check(await page.locator('.pulse').evaluate(e=>getComputedStyle(e).animationName)==='none','waiting pulse static');await rail('null402');
     }
     if(id==='EDGE-017'){
      await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Skip to the parameters'})).toBeFocused();check(await page.locator('.skip').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),'focused skip link onscreen');await page.keyboard.press('Enter');await expect(page).toHaveURL(/#params$/);check(await page.locator('#params').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.top<innerHeight;}),'parameters exposed by skip link');
     }
     if(id==='EDGE-020'){
      const fit=async state=>{const dims=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));check(dims.scroll<=dims.width,`${state}: no page overflow`,dims);await page.locator('.send').scrollIntoViewIfNeeded();await expect(page.locator('.send')).toBeInViewport();if(await v().locator('.v-badge').count()){await v().locator('.v-badge').scrollIntoViewIfNeeded();await expect(v().locator('.v-badge')).toBeInViewport();}await shot(state);};
      await fit('empty');for(const state of ['paid','refused','pending','unverified']){await page.getByRole('radio',{name:/x402 payment/}).click();if(state==='refused')await page.getByRole('radio',{name:/Wrong invoice memo/}).click();if(state==='pending')await page.getByLabel('minConf',{exact:true}).fill('100000000');await live(state==='unverified'?'quorum':'normal');await expect(v().locator('.v-badge')).toHaveText({paid:'Paid',refused:'Not paid',pending:'Pending',unverified:'Unverified'}[state]);await fit(state);await page.unroute('**/api/verify');}
      for(const [state,mode]of [['setup','setup'],['error','bad']]){await live(mode);await expect(v()).toContainText(state==='setup'?'Setup required':'Could not check');await expect(resp().locator('.status')).toHaveText(state==='setup'?'HTTP 503':'HTTP 502');await fit(state);await page.unroute('**/api/verify');}
     }
     if(id==='EDGE-021'){
      await rail('null402');const fit=async state=>{const dims=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));check(dims.width===375&&dims.scroll<=dims.width,`${state}: no page overflow`,dims);for(const selector of ['.send','.v-badge','.pane','.checks','#history .log','input[aria-label="settle_tx"]'])for(const el of await page.locator(selector).all()){if(!await el.isVisible())continue;await el.scrollIntoViewIfNeeded();const r=await el.boundingBox();check(r.x>=-1&&r.x+r.width<=376,`${state}: ${selector} fits horizontally`,r);}await expect(page.locator('.send')).toBeEnabled();await shot(state);};
      await fit('proof-inputs');await send();await expect(v().locator('.v-badge')).toHaveText('Not paid');const body=JSON.parse(await resp().locator('pre').innerText());check(body.checks.proofValid===true&&body.checks.rootKnown===true&&body.checks.nullifierSpent===true,'live Fuji proof/root/spent checks');await fit('proof-result');await expect(hist()).toHaveCount(1);await hist().scrollIntoViewIfNeeded();await fit('proof-history');
     }
     if(id==='EDGE-022'){
      await page.evaluate(()=>document.fonts.ready);const fs=await page.evaluate(async()=>{const requested={};for(const family of ['Hanken Grotesk','JetBrains Mono'])requested[family]=(await document.fonts.load(`400 16px "${family}"`)).map(f=>({family:f.family,status:f.status}));return {requested,loaded:[...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family),body:getComputedStyle(document.body).fontFamily,code:getComputedStyle(document.querySelector('code')).fontFamily};});
      const ns=ev.network.filter(x=>x.surface===surface),bad=ev.requestFailures.filter(x=>x.surface===surface&&/fonts\.(googleapis|gstatic)\.com/.test(x.url));check(!bad.length,'zero failed Google Fonts requests',bad);for(const host of ['fonts.googleapis.com','fonts.gstatic.com']){const reqs=ns.filter(x=>x.url.includes(host));check(reqs.length>0&&reqs.every(x=>x.status>=200&&x.status<300),`${host} actual requests succeeded`,reqs);}
      for(const family of ['Hanken Grotesk','JetBrains Mono'])check(fs.requested[family].length>0&&fs.requested[family].every(f=>f.status==='loaded'),`${family} loaded`,fs);check(fs.body.includes('Hanken Grotesk')&&fs.code.includes('JetBrains Mono'),'font families used on body and code',fs);
     }
     if(['EDGE-023','EDGE-024'].includes(id)){
      const prefix=id==='EDGE-023'?'https://testnet.zecblock.com/tx/':'https://testnet.snowtrace.io/tx/';const links=await page.locator(`a[href^="${prefix}"]`).evaluateAll(es=>es.map(e=>({href:e.href,label:e.textContent.trim()})));ev.checks.push({surface,name:'Actually rendered explorer links',pass:true,actual:links});
      if(['landing','liveLanding'].includes(surface))check(links.length===0,'landing overview has no invented explorer links');else{
       check(links.length>0,'rendered transaction links exist');for(const link of links){const hash=link.href.slice(prefix.length);check(id==='EDGE-023'?/^[a-f0-9]{64}$/.test(hash):hash==='0x8596f52de2d8c15680c96a0fa25b1bb5073324155f586203507cddf92f5ca593','published transaction target',link);if(/[a-f0-9]{6,}/i.test(link.label)){const parts=link.label.replace('↗','').trim().split('…');check(hash.startsWith(parts[0])&&(parts.length===1||hash.endsWith(parts[1])),'hash label matches href',link);}}
       // Inspect each distinct destination once per row, regardless of repeated links across surfaces.
       ev.destinations??={};for(const href of [...new Set(links.map(x=>x.href))])if(!ev.destinations[href]){
        const dest=await context.newPage();observe(dest);try{const res=await dest.goto(href,{waitUntil:'domcontentloaded',timeout:12000});const hash=href.split('/').pop();await dest.getByText(hash,{exact:false}).first().waitFor({timeout:8000}).catch(()=>{});const text=await dest.locator('body').innerText({timeout:3000});const found=text.toLowerCase().includes(hash.toLowerCase())&&!/transaction not found|no transaction found/i.test(text);ev.destinations[href]={status:res?.status(),url:dest.url(),requestedHashVisible:found,title:clean(await dest.title()),bodyExcerpt:clean(text.slice(0,1600))};check(res?.ok()&&dest.url().toLowerCase().includes(hash.toLowerCase())&&found,'explorer loads exact requested transaction',ev.destinations[href]);}catch(e){ev.destinations[href]??={error:clean(e.message)};check(false,'explorer loads exact requested transaction',ev.destinations[href]);}finally{if(id==='EDGE-024'&&!ev.screenshots.length){const imagePath=`${dir}/${id}.jpg`;try{const buf=await dest.screenshot({type:'jpeg',quality:20,timeout:3000});check(buf.length<=200000,'explorer screenshot <=200 KB');await writeFile(imagePath,buf);ev.screenshots.push(imagePath);}catch{}}await dest.close();}
       }
       for(const href of [...new Set(links.map(x=>x.href))]){const d=ev.destinations[href];check(d?.status>=200&&d.status<300&&d.requestedHashVisible,'linked explorer destination satisfies contract',d);}
      }
     }
     await shot('result');check(!ev.pageErrors.some(e=>e.surface===surface&&e.document.startsWith(urls[surface])),'zero uncaught page errors');ev.surfaces[surface]='PASS';
    }catch(e){ev.errors.push({surface,message:clean(e.message)});ev.surfaces[surface]='FAIL';try{await shot('failure');}catch{}}finally{if(context)await context.close().catch(()=>{});}
   }
  };
  let timer;try{await Promise.race([task(),new Promise((_,rej)=>{timer=setTimeout(()=>rej(Error('90 second row deadline')),90000);})]);}catch(e){ev.errors.push({surface,message:clean(e.message)});}finally{clearTimeout(timer);for(const c of contexts)await c.close().catch(()=>{});}
  const intended=r=>{
   const text=r.error||r.text||'';
   if(id==='EDGE-005'&& (r.url===closed+'/api/health'||r.url===closed+'/api/verify'||text.includes(closed)))return true;
   if(['EDGE-004','EDGE-007','EDGE-020'].includes(id)&&(/api\/verify/.test(r.url||''))&&(!r.status||[400,502,503].includes(r.status)))return true;
   if(['EDGE-006','EDGE-009','EDGE-010','EDGE-015'].includes(id)&&(/api\/verify|ext\/bc\/C\/rpc/.test(r.url||'')||/ERR_ABORTED/.test(text)))return true;
   if(id==='EDGE-008'&&(/ext\/bc\/C\/rpc/.test(r.url||'')||/ERR_FAILED/.test(text)))return true;
   return false;
  };
  ev.expectedFaults={http:ev.network.filter(r=>r.status>=400&&intended(r)),console:ev.console.filter(r=>r.type==='error'&&intended(r)),requests:ev.requestFailures.filter(intended)};
  ev.unexpected={http:ev.network.filter(r=>r.status>=400&&!intended(r)),console:ev.console.filter(r=>r.type==='error'&&!intended(r)),requests:ev.requestFailures.filter(r=>!intended(r)),pageErrors:ev.pageErrors};
  ev.durationMs=Date.now()-Date.parse(ev.at);row.status=ev.errors.length||Object.values(ev.unexpected).some(x=>x.length)?'FAIL':'PASS';if(id==='EDGE-024'&&Object.values(ev.destinations??{}).some(d=>d.status===403&&/Just a moment/i.test(d.title??''))){row.status='UNTESTED';for(const name of Object.keys(ev.surfaces))if(ev.surfaces[name]==='FAIL')ev.surfaces[name]='UNTESTED';row.dependency='needs testnet.snowtrace.io to serve the recorded settlement to headless Chrome without a Cloudflare challenge; the rendered href is the published hash.';}const file=`${dir}/${id}-edges-${attempt}.json`;row.evidence.push(file);row.surfaces=ev.surfaces;ev.status=row.status;await writeFile(file,JSON.stringify(ev,(_,v)=>typeof v==='string'?clean(v):v,2)+'\n');await persist();console.log(`${id} ${row.status} ${ev.errors.map(x=>x.surface+': '+x.message.split('\n')[0]).join('; ')} unexpected=${JSON.stringify(Object.fromEntries(Object.entries(ev.unexpected).map(([k,v])=>[k,v.length])))}`);
 }
}finally{
 if(browser)await browser.close().catch(()=>{});if(chrome)await chrome.close().catch(()=>{});for(const p of children.reverse())await stop(p);for(const f of configs)await rm(f,{force:true});if(tlsDir)await rm(tlsDir,{recursive:true,force:true});manifest.finished=new Date().toISOString();await saveSession();
}

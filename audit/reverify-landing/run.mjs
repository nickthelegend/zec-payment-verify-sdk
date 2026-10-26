import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,stat,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {landing,reference} from './handlers.mjs';
const require=createRequire(new URL('../../e2e/package.json',import.meta.url));
const {chromium,expect}=require('@playwright/test');
const dir='audit/reverify-landing',statusFile='audit/status/reverify-landing.json';
const ids=[...Array.from({length:20},(_,i)=>`PAGE-${String(i+1).padStart(3,'0')}`),...Array.from({length:10},(_,i)=>`HERO-${String(i+1).padStart(3,'0')}`),'EDGE-013','EDGE-014','EDGE-016','EDGE-018','EDGE-019'];
const selected=process.argv.slice(2).length?process.argv.slice(2):ids;
assert(selected.every(id=>ids.includes(id)));
let results=ids.map(id=>({id,status:'UNTESTED',evidence:[],fix:''}));
if(selected.length!==ids.length)try{results=JSON.parse(await readFile(statusFile,'utf8'));}catch{}
const persist=()=>writeFile(statusFile,JSON.stringify(results,null,2)+'\n');
await mkdir(dir,{recursive:true});await persist();
const manifest={started:new Date().toISOString(),runnerPid:process.pid,channel:'chrome',video:false,trace:false,rowTimeoutMs:90000,rows:selected,processes:[]};
const clean=s=>String(s).replace(/u(?:ivk|fvk|view)(?:test)?1[a-z0-9…]+/gi,'[REDACTED]').slice(0,1800);
const track=(name,child)=>{const entry={name,pid:child.pid};manifest.processes.push(entry);child.once('exit',(code,signal)=>Object.assign(entry,{exited:true,code,signal}));return child;};
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;process.kill(child.pid,'SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,1500))]);if(child.exitCode===null&&child.signalCode===null)process.kill(child.pid,'SIGKILL');}
async function command(name,cmd,args,options={}){const p=track(name,spawn(cmd,args,{stdio:['ignore','pipe','pipe'],...options}));let log='';p.stdout.on('data',d=>log+=d);p.stderr.on('data',d=>log+=d);const code=await new Promise((res,rej)=>{p.once('exit',res);p.once('error',rej);});await writeFile(`${dir}/${name}.txt`,clean(log).trimEnd()+'\n');assert.equal(code,0,`${name}: ${clean(log)}`);}
let server,chrome,browser,configPath;
const dependency='needs Claude to redeploy hanko-landing-six after this run; local HERO-003 is the tested surface';
const repo='https://github.com/nickthelegend/zec-payment-verify-sdk';
const origins={live:'https://hanko-landing-six.vercel.app/',local:'http://127.0.0.1:5197/',pages:'http://127.0.0.1:5198/'};
try{
 await command('sdk-build','pnpm',['--filter','@zpv/sdk','build']);
 // Invoke the actual Pages script, adding only a Vite config with envDir:false. No .env is read.
 configPath=resolve('packages/dashboard/.reverify.config.mjs');
 await writeFile(configPath,`import base from './vite.config.ts';\nexport default {...base,envDir:false};\n`);
 await command('pages-build','bash',['-c','node() { command node "$@" --config "$HANKO_AUDIT_VITE_CONFIG"; }; export -f node; bash scripts/build-pages.sh site'],{env:{...process.env,HANKO_AUDIT_VITE_CONFIG:configPath}});
 await rm(configPath);configPath=null;
 server=track('static server',spawn(process.execPath,['e2e/serve-static.mjs','5197:packages/landing','5198:site'],{stdio:['ignore','pipe','pipe']}));
 await new Promise((res,rej)=>{server.stdout.once('data',res);server.once('error',rej);server.once('exit',c=>rej(Error(`server exit ${c}`)));});
 chrome=await chromium.launchServer({channel:'chrome',headless:true});track('Google Chrome',chrome.process());browser=await chromium.connect(chrome.wsEndpoint());manifest.browser=browser.version();manifest.origins=origins;
 console.log(`Chrome ${browser.version()}, runner ${process.pid}, static ${server.pid}, Chrome ${chrome.process().pid}`);
 let liveHero=false;
 for(const id of selected){
  const started=Date.now(),ev={id,at:new Date().toISOString(),browser:browser.version(),checks:[],surfaces:[],console:[],pageErrors:[],network:[],requestFailures:[],errors:[],screenshots:[]};
  const isRef=/PAGE-0(09|1[0-9]|20)/.test(id)||['EDGE-014','EDGE-016','EDGE-019'].includes(id);
  const urls=Object.fromEntries(Object.entries(origins).map(([k,v])=>[k,v+(isRef?'reference.html':'')]));
  let ctx,page,surface,cancelled=false,status='PASS';
  const ensure=(ok,check,actual)=>{ev.checks.push({surface,check,pass:!!ok,...(actual===undefined?{}:{actual})});assert(ok,check);};
  const open=async(name,options={},init)=>{
   if(cancelled)throw Error('row cancelled');if(ctx){await page.waitForLoadState('networkidle').catch(()=>{});await ctx.close();}
   surface=name;ctx=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'no-preference',...options});if(init)await ctx.addInitScript(init);
   page=await ctx.newPage();page.setDefaultTimeout(6000);page.setDefaultNavigationTimeout(20000);
   page.on('console',m=>ev.console.push({surface:name,type:m.type(),text:clean(m.text())}));page.on('pageerror',e=>ev.pageErrors.push({surface:name,message:clean(e.message)}));
   page.on('response',r=>ev.network.push({surface:name,url:clean(r.url()),status:r.status(),resourceType:r.request().resourceType(),contentType:r.headers()['content-type']||''}));
   page.on('requestfailed',r=>ev.requestFailures.push({surface:name,url:clean(r.url()),error:r.failure()?.errorText}));
   const response=await page.goto(urls[name],{waitUntil:'load'});ensure(response.status()===200,'document HTTP 200',response.status());await page.locator('h1').waitFor();await page.evaluate(()=>document.fonts.ready);
   ev.surfaces.push({surface:name,url:urls[name],viewport:page.viewportSize(),reducedMotion:options.reducedMotion||'no-preference'});return response;
  };
  const each=async(...args)=>{let names,fn,options,init;if(Array.isArray(args[0]))[names,fn,options,init]=args;else{names=['live','local'];[fn,options,init]=args;}for(const name of names)try{await open(name,options,init);await fn(name);}catch(e){ev.errors.push({surface:name,message:clean(e.message)});}};
  const screenshot=async suffix=>{const path=`${dir}/${id}-${surface}-${suffix}.jpg`;const buffer=await page.screenshot({type:'jpeg',quality:20,fullPage:false,timeout:10000});ensure(buffer.length<=200000,'screenshot <=200 KB',buffer.length);await writeFile(path,buffer);ev.screenshots.push(path);};
  const selectedLink=hash=>page.locator(`#toc a[href="#${hash}"]`);
  const belowBars=async hash=>{const rect=await page.locator(`#${hash}`).evaluate(el=>{const top=document.querySelector('.top').getBoundingClientRect().bottom,nav=document.querySelector('.side').getBoundingClientRect();return {y:el.getBoundingClientRect().top,bars:innerWidth<=900?Math.max(top,nav.bottom):top,height:innerHeight};});ensure(rect.y>=rect.bars-1&&rect.y<rect.height,`#${hash} exposed below sticky bars`,rect);};
  const navigate=async hash=>{await selectedLink(hash).click();await expect(page).toHaveURL(new RegExp(`#${hash}$`));await belowBars(hash);await expect(selectedLink(hash)).toHaveAttribute('aria-current','true');ensure(await page.locator('#toc a[aria-current="true"]').count()===1,'exactly one current section');};
  const pageProxy=new Proxy({}, {get:(_,key)=>typeof page[key]==='function'?page[key].bind(page):page[key]});const contextProxy=new Proxy({}, {get:(_,key)=>typeof ctx[key]==='function'?ctx[key].bind(ctx):ctx[key]});
  const text=selector=>page.locator(selector).innerText();
  const styles=(selector,pseudo)=>page.locator(selector).evaluate((el,pseudo)=>{const s=getComputedStyle(el,pseudo);return Object.fromEntries(['position','top','right','bottom','left','objectFit','content','animationName','animationDuration','animationDelay','animationIterationCount','animationDirection','animationPlayState','opacity','display','backgroundImage','backdropFilter'].map(k=>[k,s[k]]));},pseudo);
  const task=async()=>{
   // Disk and image-network rows need the explicit open helper as well as UI assertions.
   const h={id,each,ensure,readFile,stat,text,styles,screenshot,config:{urls},urls,ev,dependency,repo,liveHero,pageProxy,contextProxy,surface:()=>surface,expect,selectedLink,belowBars,navigate,open,clean};
   const result=await (isRef?reference(h):landing(h));if(result)liveHero=result.liveHero;
   if(id==='HERO-009'&&ev.dependency)status='UNTESTED';
   await page?.waitForLoadState('networkidle');
  };
  let timer;try{await Promise.race([task(),new Promise((_,reject)=>{timer=setTimeout(()=>{cancelled=true;reject(Error('90 second row deadline exceeded'));},90000);})]);}catch(e){ev.errors.push({surface,message:clean(e.message)});}finally{clearTimeout(timer);if(ctx)await ctx.close();}
  ev.failures={console:ev.console.filter(m=>m.type==='error'),network:ev.network.filter(r=>r.status>=400),pageErrors:ev.pageErrors,requests:ev.requestFailures};
  if(ev.errors.length||Object.values(ev.failures).some(a=>a.length))status='FAIL';ev.status=status;ev.durationMs=Date.now()-started;
  const path=`${dir}/${id}.json`;await writeFile(path,JSON.stringify(ev,null,2)+'\n');const row=results.find(r=>r.id===id);row.status=status;row.evidence=[path,...ev.screenshots];if(status==='UNTESTED')row.evidence.push(dependency);await persist();
  console.log(`${id} ${status} ${ev.checks.length} checks ${ev.durationMs}ms ${JSON.stringify(ev.errors)} errors=${JSON.stringify(Object.fromEntries(Object.entries(ev.failures).map(([k,v])=>[k,v.length])))}`);
 }
}finally{
 if(browser)await browser.close();if(chrome){await chrome.close();await stop(chrome.process());}await stop(server);if(configPath)await rm(configPath,{force:true});manifest.finished=new Date().toISOString();await writeFile(`${dir}/session.json`,JSON.stringify(manifest,null,2)+'\n');
 await command('slot-release','/Volumes/Extreme SSD/Projects/grokbot/tools/heavy-slot.sh',['release','audit-t9']);
}

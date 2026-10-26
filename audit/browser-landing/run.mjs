import { createRequire } from 'node:module';
import { readFile, writeFile, stat } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../e2e/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const dir = 'audit/browser-landing';
const config = JSON.parse(await readFile(`${dir}/config.json`, 'utf8'));
const ids = ['PAGE-001','PAGE-002','PAGE-003','PAGE-004','PAGE-005','PAGE-006','PAGE-007','PAGE-008',...Array.from({length:10},(_,i)=>`HERO-${String(i+1).padStart(3,'0')}`),'EDGE-013','EDGE-018'];
let results = ids.map(id=>({id,status:'UNTESTED',evidence:[],fix:''}));
try { results = JSON.parse(await readFile('audit/status/browser-landing.json','utf8')); } catch {}
const persist = () => writeFile('audit/status/browser-landing.json', JSON.stringify(results,null,2)+'\n');
await persist();
const browser = await chromium.launch({channel:config.channel,headless:true});
console.log(`runner PID ${process.pid}; browser ${browser.version()}`);
const dependency = 'needs Claude to redeploy hanko-landing-six after this run; local HERO-003 is the tested surface.';
const repo = 'https://github.com/nickthelegend/zec-payment-verify-sdk';
const clean = value => String(value).replace(/(?:uivk(?:test)?1|u(?:fvk|view)(?:test)?1)[a-z0-9]+/gi,'[REDACTED]').slice(0,1500);
let liveHero = false;
let runNumber = Math.max(0,...results.flatMap(r=>r.evidence.map(p=>Number(p.match(/-(\d+)\.json$/)?.[1]||0))));
async function row(id) {
  runNumber++;
  const ev = {id,attempt:runNumber,at:new Date().toISOString(),browser:browser.version(),checks:[],surfaces:[],console:[],pageErrors:[],network:[],requestFailures:[],errors:[]};
  let ctx, page, currentSurface;
  const ensure = (condition,message,actual) => {ev.checks.push({surface:currentSurface,check:message,pass:!!condition,...(actual===undefined?{}:{actual})}); assert.ok(condition,message);};
  const open = async (surface, options={}) => {
    if(ctx) await ctx.close();
    currentSurface=surface;
    ctx = await browser.newContext({viewport:config.viewport,reducedMotion:'no-preference',...options});
    page = await ctx.newPage(); page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(25000);
    page.on('console',msg=>ev.console.push({surface,type:msg.type(),text:clean(msg.text())}));
    page.on('pageerror',e=>ev.pageErrors.push({surface,message:clean(e.message)}));
    page.on('response',r=>ev.network.push({surface,url:clean(r.url()),status:r.status(),resourceType:r.request().resourceType(),contentType:r.headers()['content-type']||''}));
    page.on('requestfailed',r=>ev.requestFailures.push({surface,url:clean(r.url()),error:r.failure()?.errorText||''}));
    const response=await page.goto(config.urls[surface],{waitUntil:'load'});
    ev.surfaces.push({surface,url:config.urls[surface],status:response.status(),viewport:await page.viewportSize(),reducedMotion:options.reducedMotion||'no-preference'});
    ensure(response.status()===200,'landing document HTTP 200',response.status());
    await page.locator('h1').waitFor();
    return response;
  };
  const screenshot = async suffix => {
    const path=`${dir}/${id}-${suffix}-${runNumber}.jpg`;
    const buffer=await page.screenshot({type:'jpeg',quality:45,fullPage:false,timeout:10000});
    ensure(buffer.length<=200000,'screenshot at most 200 KB',buffer.length);
    await writeFile(path,buffer); ev.screenshots??=[]; ev.screenshots.push(path);
  };
  const text = selector => page.locator(selector).innerText();
  const styles = (selector,pseudo) => page.locator(selector).evaluate((el,pseudo)=>{
    const s=getComputedStyle(el,pseudo); return Object.fromEntries(['position','top','right','bottom','left','objectFit','content','animationName','animationDuration','animationDelay','animationIterationCount','animationDirection','animationPlayState','opacity','display','backgroundImage','backdropFilter'].map(k=>[k,s[k]]));
  },pseudo);
  const each = async (surfaces,fn,options) => {for(const surface of surfaces){try{await open(surface,options);await fn(surface);}catch(e){ev.errors.push({surface,message:clean(e.message)});}}};
  let status='PASS';
  const task=async()=>{
    if(id==='PAGE-001') await each(['live','local'],async()=>{
      ensure(await page.title()==='Hanko · was I paid?','exact title',await page.title());
      ensure(await text('h1')==='Was I paid? Ask with a viewing key.','exact h1',await text('h1'));
      ensure(await text('.sub')==="Hanko checks a shielded Zcash payment's amount, memo and depth with a key that can never spend.",'exact subline',await text('.sub'));
      await screenshot(currentSurface);
    });
    if(id==='PAGE-002') await each(['live','local'],async()=>{
      const request=await text('.pane pre >> nth=0'), response=await text('.pane pre >> nth=1');
      ensure(/amountZat:\s*100_000/.test(request)&&request.includes("'x402z-f19a63da20cbc0749ea800b3'"),'request amount and memo',request);
      ensure(/"ok":\s*true/.test(response)&&/"paid_zat":\s*100000/.test(response)&&/"reasons":\s*\[\]/.test(response),'exact response values',response);
      ensure(await text('.ok >> nth=0')==='exit 0 · paid','paid exit label');
      ensure((await page.locator('#seal').textContent()).includes('PAID')&&(await page.locator('#seal').textContent()).includes('VIEWING KEY'),'seal labels');
      ensure((await text('figcaption')).includes('Excerpt of real zpay-verify output, Oct 21, 2026.'),'exact recorded caption');
      await page.waitForTimeout(1200); await screenshot(currentSurface);
    });
    if(id==='PAGE-003') await each(['live','pages'],async()=>{
      const links=page.locator('a').filter({hasText:/^(Open the console|Console)$/});
      ensure(await links.count()===4,'hero/end/nav/footer console links',await links.count());
      for(let i=0;i<4;i++){
        await page.goto(config.urls[currentSurface],{waitUntil:'load'});
        const link=page.locator('a').filter({hasText:/^(Open the console|Console)$/}).nth(i);
        const href=await link.getAttribute('href'); ensure(href==='dashboard/','same deployment dashboard href',href);
        const [r]=await Promise.all([page.waitForNavigation({waitUntil:'load'}),link.click()]);
        ensure(r.status()===200&&page.url()===new URL('dashboard/',config.urls[currentSurface]).href,'clicked console HTTP 200 on same deployment',{status:r.status(),url:page.url()});
      }
      ev.notes='Local console links exercised on scripts/build-pages.sh output, which supplies dashboard/ alongside the landing. No console inputs or response bodies recorded.';
    });
    if(id==='PAGE-004') await each(['live','local'],async()=>{
      const count=await page.locator('a[href="reference.html"]').count();ensure(count===3,'hero/nav/footer API reference links',count);
      for(let i=0;i<count;i++){
        await page.goto(config.urls[currentSurface],{waitUntil:'load'});
        const [r]=await Promise.all([page.waitForNavigation({waitUntil:'load'}),page.locator('a[href="reference.html"]').nth(i).click()]);
        ensure(r.status()===200&&page.url()===new URL('reference.html',config.urls[currentSurface]).href,'reference navigation HTTP 200');
      }
      await page.goto(config.urls[currentSurface],{waitUntil:'load'});
      await page.getByRole('link',{name:'See the evidence'}).click();
      ensure(page.url()===new URL('reference.html#evidence',config.urls[currentSurface]).href,'evidence target exact');
      ensure(await text('#evidence h2')==='Live testnet run','exact evidence heading',await text('#evidence h2'));
    });
    if(id==='PAGE-005') await each(['live','local'],async()=>{
      const steps=await page.locator('.steps h3').allTextContents(), facts=await page.locator('.facts b').allTextContents();
      ensure(JSON.stringify(steps)===JSON.stringify(['Share a viewing key','Name the payment','Get the answer']),'exact steps',steps);
      ensure(JSON.stringify(facts)===JSON.stringify(['104','49','0']),'exact facts',facts);
      const testing=await readFile('TESTING.md','utf8');
      ensure(/\*\*104 \+ 1 doc example\*\*\s*\|\s*\*\*49\*\*/.test(testing),'TESTING.md totals 104 and 49');
      ensure((await page.locator('.facts').textContent()).includes('Spend keys')&&(await text('.steps')).includes('It can never spend them.'),'zero spend-key claim');
    });
    if(id==='PAGE-006') await each(['live','local'],async()=>{
      ensure(JSON.stringify(await page.locator('.strip h3').allTextContents())===JSON.stringify(['Live','Setup required']),'exact live/setup headings');
      ensure(await page.getByRole('link',{name:'hosted verify API',exact:true}).getAttribute('href')==='https://hanko-api.201-18-198-162.sslip.io/api/health','exact hosted API target');
      const setup=await text('.setup');ensure(setup.includes('tarball')&&setup.includes('Testnet only.'),'tarball and testnet setup copy',setup);
    });
    if(id==='PAGE-007') await each(['live','local'],async()=>{
      ensure(await page.locator('.brand').getAttribute('href')==='./','brand href ./');await page.locator('.brand').click();ensure(page.url()===config.urls[currentSurface],'brand returns home');
      const github=await page.getByRole('link',{name:'GitHub',exact:true}).evaluateAll(as=>as.map(a=>a.getAttribute('href')));
      ensure(github.length===2&&github.every(h=>h===repo),'GitHub links point to repo',github);
      ensure(await page.getByRole('link',{name:'Tests',exact:true}).getAttribute('href')===`${repo}/blob/main/TESTING.md`,'Tests link');
      const footer=await text('footer');ensure(['MIT, Copyright (c) 2026 Nivesh Gajengi','Zcash testnet','not audited'].every(t=>footer.includes(t)),'exact footer copy',footer);
      ensure(await page.getByRole('button',{name:/log/i}).count()===0,'no log button');
    });
    if(id==='PAGE-008') await each(['live','local'],async()=>{
      // Reload to observe the actual initial state before the 700ms timer.
      await page.goto(config.urls[currentSurface],{waitUntil:'commit'});
      await page.locator('#seal').waitFor({state:'attached'});
      const initial=await page.locator('#seal').getAttribute('class');ensure(initial==='seal armed','initial seal armed',initial);
      await page.locator('#seal.land').waitFor({state:'attached'});
      await page.waitForTimeout(1000);
      const initialTiming=await page.locator('#seal').evaluate(el=>({opacity:getComputedStyle(el).opacity,animations:el.getAnimations().map(a=>({startTime:a.startTime,playState:a.playState,currentTime:a.currentTime}))}));
      ensure(initialTiming.opacity==='0.94','press ends at opacity .94',initialTiming);
      await page.locator('footer').scrollIntoViewIfNeeded();await page.locator('#seal').scrollIntoViewIfNeeded();
      const after=await page.locator('#seal').evaluate(el=>({class:el.getAttribute('class'),opacity:getComputedStyle(el).opacity,animations:el.getAnimations().map(a=>({startTime:a.startTime,playState:a.playState,currentTime:a.currentTime}))}));
      ensure(after.class==='seal land'&&after.opacity==='0.94'&&JSON.stringify(after.animations)===JSON.stringify(initialTiming.animations),'scroll does not replay press',after);
    });
    if(id==='HERO-001'){
      await open('local');const file='packages/landing/assets/hero.webp',buffer=await readFile(file);
      ensure(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP','RIFF/WEBP format');ensure(buffer.length>10240,'asset greater than 10 KB',buffer.length);
      const decoded=await page.locator('.stage img').evaluate(async img=>{await img.decode();return [img.naturalWidth,img.naturalHeight];});ensure(JSON.stringify(decoded)==='[1600,900]','decoded pixel dimensions',decoded);
    }
    if(id==='HERO-002')await each(['local','live'],async()=>{
      const image=await page.locator('section.hero div.stage[aria-hidden="true"] img').evaluate(el=>Object.fromEntries(['src','alt','width','height','fetchpriority','decoding'].map(k=>[k,el.getAttribute(k)])));
      ensure(JSON.stringify(image)===JSON.stringify({src:'assets/hero.webp',alt:'',width:'1600',height:'900',fetchpriority:'high',decoding:'async'}),'exact stage markup',image);
    });
    if(id==='HERO-003'||id==='HERO-008'){
      await open(id==='HERO-008'?'pages':'local');
      if(id==='HERO-008'){ensure((await stat('site/assets/hero.webp')).size>10240,'Pages asset exists');ensure((await readFile('site/index.html','utf8')).includes('src="assets/hero.webp"'),'built index references copied asset');}
      const img=page.locator('.stage img');const dimensions=await img.evaluate(async el=>{await el.decode();return [el.naturalWidth,el.naturalHeight];});
      const response=ev.network.find(r=>r.url===new URL('assets/hero.webp',config.urls[currentSurface]).href);
      ensure(response?.status===200&&response?.contentType.startsWith('image/webp'),'image HTTP 200 image/webp',response);
      ensure(JSON.stringify(dimensions)==='[1600,900]','natural dimensions 1600x900',dimensions);
    }
    if(['HERO-004','HERO-005','HERO-006','HERO-007'].includes(id)){
      await each(liveHero?['local','live']:['local'],async()=>{
        const stage=await styles('.stage'),before=await styles('.stage','::before');
        ev.computed={stage,before};
        if(id==='HERO-004'){
          ensure(stage.position==='absolute'&&['top','right','bottom','left'].every(k=>stage[k]==='0px'),'stage absolute inset zero',stage);
          ensure((await styles('.stage img')).objectFit==='cover','image object fit cover');
          const after=await styles('.stage','::after');ensure(after.content==='""'&&after.backgroundImage.includes('linear-gradient'),'scrim paints',after);
          ensure(await page.locator('h1').isVisible()&&(await text('h1')).includes('Was I paid?'),'h1 visible');ensure((await styles('.top nav')).backdropFilter.includes('blur('),'header nav blur');
          await page.waitForTimeout(2500);await screenshot(currentSurface);
        }
        if(id==='HERO-005')ensure(stage.animationName==='hk-drift'&&stage.animationDuration==='24s'&&stage.animationIterationCount==='infinite'&&stage.animationDirection==='alternate','exact camera animation',stage);
        if(id==='HERO-006')ensure(before.content==='""'&&before.animationName==='hk-sweep'&&before.animationDuration==='9s'&&before.animationDelay==='2.6s'&&before.animationIterationCount==='infinite'&&before.animationPlayState==='running','exact light sweep',before);
        if(id==='HERO-007')ensure(stage.animationName==='none'&&before.animationName==='none','no stage or sweep animation under reduced motion',{stage:stage.animationName,before:before.animationName});
      },{reducedMotion:id==='HERO-007'?'reduce':'no-preference'});
      if(!liveHero)ev.liveDependency=dependency;
    }
    if(id==='HERO-009'){
      await open('live');liveHero=await page.locator('.stage img[src="assets/hero.webp"]').count()>0;
      if(!liveHero){status='UNTESTED';ev.dependency=dependency;ev.checks.push({surface:'live',check:'live hero absent',pass:false,dependency});}
      else{const dimensions=await page.locator('.stage img').evaluate(async el=>{await el.decode();return [el.naturalWidth,el.naturalHeight];});const r=ev.network.find(r=>r.url===new URL('assets/hero.webp',config.urls.live).href);ensure(r?.status===200&&r?.contentType.startsWith('image/webp')&&JSON.stringify(dimensions)==='[1600,900]','live hero HTTP 200 WebP 1600x900',{response:r,dimensions});}
    }
    if(id==='HERO-010'||id==='EDGE-018')await each(id==='HERO-010'?(liveHero?['local','live']:['local']):['local','live'],async()=>{
      await page.waitForTimeout(1500);
      const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));ensure(width.scroll===width.client,'375px no horizontal page scroll',width);
      if(id==='HERO-010'){
        const image=await page.locator('.stage img').evaluate(el=>({height:el.getBoundingClientRect().height,naturalWidth:el.naturalWidth}));ensure(image.height>0&&image.naturalWidth===1600,'stage image rendered and decoded',image);
        const h=await page.locator('h1').boundingBox();ensure(h.x>=0&&h.y>=0&&h.x+h.width<=375&&h.y+h.height<=812,'h1 fully inside viewport',h);
        await page.waitForTimeout(3500);ensure(await page.evaluate(()=>document.documentElement.scrollWidth===document.documentElement.clientWidth),'sweep has no horizontal overflow');
      }else{
        const selectors=['.ctas','.pane:nth-child(1)','.pane:nth-child(2)','#seal','.facts','.strip','footer'];
        for(const selector of selectors){const locator=page.locator(selector);await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();ensure(await locator.isVisible()&&box.x>=0&&box.x+box.width<=375&&box.y+box.height>0&&box.y<812,`${selector} readable and reachable`,box);await screenshot(`${currentSurface}-${selector.replace(/[^a-z0-9]/gi,'')}`);}
      }
      await page.evaluate(()=>scrollTo(0,0));await screenshot(currentSurface);
    },{viewport:{width:375,height:812},reducedMotion:'no-preference'});
    if(id==='EDGE-013')await each(['local','live'],async()=>{
      const seal=await styles('#seal'),stage=await page.locator('.stage').count()?await styles('.stage'):null,before=stage?await styles('.stage','::before'):null;
      ensure(!(await page.locator('#seal').getAttribute('class')).includes('armed'),'seal unarmed');ensure(seal.animationName==='none'&&seal.opacity==='0.94','seal opacity .94 and animation none',seal);
      ensure((await styles('#seal .bleed')).display==='none','bleed hidden');ensure(await page.locator('#seal').isVisible(),'seal visible');
      if(stage)ensure(stage.animationName==='none'&&before.animationName==='none','stage and sweep animation none',{stage,before});else ev.liveDependency=dependency;
      await page.locator('#seal').scrollIntoViewIfNeeded();await screenshot(currentSurface);
    },{reducedMotion:'reduce'});
    await page?.waitForTimeout(200);
  };
  let timer;
  try{await Promise.race([task(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('row timeout 90000ms')),90000);})]);}catch(e){ev.errors.push({surface:currentSurface,message:clean(e.message)});}finally{clearTimeout(timer);if(ctx)await ctx.close();}
  const networkErrors=ev.network.filter(r=>r.status>=400);
  const consoleErrors=ev.console.filter(r=>r.type==='error');
  if(ev.errors.length||consoleErrors.length||ev.pageErrors.length||networkErrors.length||ev.requestFailures.length)status='FAIL';
  ev.status=status;ev.failureCounts={assertions:ev.errors.length,console:consoleErrors.length,pageErrors:ev.pageErrors.length,http:networkErrors.length,requests:ev.requestFailures.length};
  const path=`${dir}/${id}-${runNumber}.json`;await writeFile(path,JSON.stringify(ev,null,2)+'\n');
  const record=results.find(r=>r.id===id);record.status=status;record.evidence.push(path,...(ev.screenshots||[]));if(id==='HERO-009'&&status==='UNTESTED')record.evidence.push(dependency);
  await persist();console.log(JSON.stringify({id,status,failures:ev.failureCounts,errors:ev.errors}));
}
try {
  const selected = process.argv.find(arg => arg.startsWith('--ids='))?.slice(6).split(',') || ids;
  if(selected.includes('HERO-009')) await row('HERO-009');
  for(const id of selected.filter(id=>id!=='HERO-009')) await row(id);
} finally {await browser.close();}

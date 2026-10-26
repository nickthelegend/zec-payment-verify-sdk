// Assertions are re-executed in fresh Chrome contexts; no prior evidence is consumed.
export async function landing(h) {
  const {id,each,ensure,readFile,stat,text,styles,screenshot,config,urls,ev,dependency,repo,open}=h;
  let liveHero=h.liveHero;
  const page=h.pageProxy;
    if(id==='PAGE-001') await each(['live','local'],async()=>{
      ensure(await page.title()==='Hanko · was I paid?','exact title',await page.title());
      ensure(await text('h1')==='Was I paid? Ask with a viewing key.','exact h1',await text('h1'));
      ensure(await text('.sub')==="Hanko checks a shielded Zcash payment's amount, memo and depth with a key that can never spend.",'exact subline',await text('.sub'));
      await screenshot(h.surface());
    });
    if(id==='PAGE-002') await each(['live','local'],async()=>{
      const request=await text('.pane pre >> nth=0'), response=await text('.pane pre >> nth=1');
      ensure(/amountZat:\s*100_000/.test(request)&&request.includes("'x402z-f19a63da20cbc0749ea800b3'"),'request amount and memo',request);
      ensure(/"ok":\s*true/.test(response)&&/"paid_zat":\s*100000/.test(response)&&/"reasons":\s*\[\]/.test(response),'exact response values',response);
      ensure(await text('.ok >> nth=0')==='exit 0 · paid','paid exit label');
      ensure((await page.locator('#seal').textContent()).includes('PAID')&&(await page.locator('#seal').textContent()).includes('VIEWING KEY'),'seal labels');
      ensure((await text('figcaption')).includes('Excerpt of real zpay-verify output, Oct 21, 2026.'),'exact recorded caption');
      await page.waitForTimeout(1200); await screenshot(h.surface());
    });
    if(id==='PAGE-003') await each(['live','pages'],async()=>{
      const links=page.locator('a').filter({hasText:/^(Open the console|Console)$/});
      ensure(await links.count()===4,'hero/end/nav/footer console links',await links.count());
      for(let i=0;i<4;i++){
        await page.goto(urls[h.surface()],{waitUntil:'load'});
        const link=page.locator('a').filter({hasText:/^(Open the console|Console)$/}).nth(i);
        const href=await link.getAttribute('href'); ensure(href==='dashboard/','same deployment dashboard href',href);
        const [r]=await Promise.all([page.waitForNavigation({waitUntil:'load'}),link.click()]);
        ensure(r.status()===200&&page.url()===new URL('dashboard/',urls[h.surface()]).href,'clicked console HTTP 200 on same deployment',{status:r.status(),url:page.url()});
      }
      ev.notes='Local console links exercised on scripts/build-pages.sh output, which supplies dashboard/ alongside the landing. No console inputs or response bodies recorded.';
    });
    if(id==='PAGE-004') await each(['live','local'],async()=>{
      const count=await page.locator('a[href="reference.html"]').count();ensure(count===3,'hero/nav/footer API reference links',count);
      for(let i=0;i<count;i++){
        await page.goto(urls[h.surface()],{waitUntil:'load'});
        const [r]=await Promise.all([page.waitForNavigation({waitUntil:'load'}),page.locator('a[href="reference.html"]').nth(i).click()]);
        ensure(r.status()===200&&page.url()===new URL('reference.html',urls[h.surface()]).href,'reference navigation HTTP 200');
      }
      await page.goto(urls[h.surface()],{waitUntil:'load'});
      await page.getByRole('link',{name:'See the evidence'}).click();
      ensure(page.url()===new URL('reference.html#evidence',urls[h.surface()]).href,'evidence target exact');
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
      ensure(await page.locator('.brand').getAttribute('href')==='./','brand href ./');await page.locator('.brand').click();ensure(page.url()===urls[h.surface()],'brand returns home');
      const github=await page.getByRole('link',{name:'GitHub',exact:true}).evaluateAll(as=>as.map(a=>a.getAttribute('href')));
      ensure(github.length===2&&github.every(h=>h===repo),'GitHub links point to repo',github);
      ensure(await page.getByRole('link',{name:'Tests',exact:true}).getAttribute('href')===`${repo}/blob/main/TESTING.md`,'Tests link');
      const footer=await text('footer');ensure(['MIT, Copyright (c) 2026 Nivesh Gajengi','Zcash testnet','not audited'].every(t=>footer.includes(t)),'exact footer copy',footer);
      ensure(await page.getByRole('button',{name:/log/i}).count()===0,'no log button');
    });
    if(id==='PAGE-008') await each(['live','local'],async()=>{
      // Reload to observe the actual initial state before the 700ms timer.
      await page.goto(urls[h.surface()],{waitUntil:'commit'});
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
    if(id==='HERO-002')await each(['local'],async()=>{
      const image=await page.locator('section.hero div.stage[aria-hidden="true"] img').evaluate(el=>Object.fromEntries(['src','alt','width','height','fetchpriority','decoding'].map(k=>[k,el.getAttribute(k)])));
      ensure(JSON.stringify(image)===JSON.stringify({src:'assets/hero.webp',alt:'',width:'1600',height:'900',fetchpriority:'high',decoding:'async'}),'exact stage markup',image);
    });
    if(id==='HERO-003'||id==='HERO-008'){
      await open(id==='HERO-008'?'pages':'local');
      if(id==='HERO-008'){ensure((await stat('site/assets/hero.webp')).size>10240,'Pages asset exists');ensure((await readFile('site/index.html','utf8')).includes('src="assets/hero.webp"'),'built index references copied asset');}
      const img=page.locator('.stage img');const dimensions=await img.evaluate(async el=>{await el.decode();return [el.naturalWidth,el.naturalHeight];});
      const response=ev.network.find(r=>r.url===new URL('assets/hero.webp',urls[h.surface()]).href);
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
          await page.waitForTimeout(2500);await screenshot(h.surface());
        }
        if(id==='HERO-005')ensure(stage.animationName==='hk-drift'&&stage.animationDuration==='24s'&&stage.animationIterationCount==='infinite'&&stage.animationDirection==='alternate','exact camera animation',stage);
        if(id==='HERO-006')ensure(before.content==='""'&&before.animationName==='hk-sweep'&&before.animationDuration==='9s'&&before.animationDelay==='2.6s'&&before.animationIterationCount==='infinite'&&before.animationPlayState==='running','exact light sweep',before);
        if(id==='HERO-007')ensure(stage.animationName==='none'&&before.animationName==='none','no stage or sweep animation under reduced motion',{stage:stage.animationName,before:before.animationName});
      },{reducedMotion:id==='HERO-007'?'reduce':'no-preference'});
      if(!liveHero)ev.liveDependency=dependency;
    }
    if(id==='HERO-009'){
      await open('live');liveHero=await page.locator('.stage img[src="assets/hero.webp"]').count()>0;
      if(!liveHero){ev.dependency=dependency;ev.checks.push({surface:'live',check:'live hero absent',pass:false,dependency});}
      else{const dimensions=await page.locator('.stage img').evaluate(async el=>{await el.decode();return [el.naturalWidth,el.naturalHeight];});const r=ev.network.find(r=>r.url===new URL('assets/hero.webp',urls.live).href);ensure(r?.status===200&&r?.contentType.startsWith('image/webp')&&JSON.stringify(dimensions)==='[1600,900]','live hero HTTP 200 WebP 1600x900',{response:r,dimensions});}
    }
    if(id==='HERO-010'||id==='EDGE-018')await each(['local','live'],async()=>{
      await page.waitForTimeout(1500);
      const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));ensure(width.scroll===width.client,'375px no horizontal page scroll',width);
      if(id==='HERO-010'){
        const image=await page.locator('.stage img').evaluate(el=>({height:el.getBoundingClientRect().height,naturalWidth:el.naturalWidth}));ensure(image.height>0&&image.naturalWidth===1600,'stage image rendered and decoded',image);
        const h=await page.locator('h1').boundingBox();ensure(h.x>=0&&h.y>=0&&h.x+h.width<=375&&h.y+h.height<=812,'h1 fully inside viewport',h);
        await page.waitForTimeout(3500);ensure(await page.evaluate(()=>document.documentElement.scrollWidth===document.documentElement.clientWidth),'sweep has no horizontal overflow');
      }else{
        const selectors=['.ctas','.pane:nth-child(1)','.pane:nth-child(2)','#seal','.facts','.strip','footer'];
        for(const selector of selectors){const locator=page.locator(selector);await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();ensure(await locator.isVisible()&&box.x>=0&&box.x+box.width<=375&&box.y+box.height>0&&box.y<812,`${selector} readable and reachable`,box);await screenshot(`${h.surface()}-${selector.replace(/[^a-z0-9]/gi,'')}`);}
      }
      await page.evaluate(()=>scrollTo(0,0));await screenshot(h.surface());
    },{viewport:{width:375,height:812},reducedMotion:'no-preference'});
    if(id==='EDGE-013')await each(['local','live'],async()=>{
      const seal=await styles('#seal'),stage=await page.locator('.stage').count()?await styles('.stage'):null,before=stage?await styles('.stage','::before'):null;
      ensure(!(await page.locator('#seal').getAttribute('class')).includes('armed'),'seal unarmed');ensure(seal.animationName==='none'&&seal.opacity==='0.94','seal opacity .94 and animation none',seal);
      ensure((await styles('#seal .bleed')).display==='none','bleed hidden');ensure(await page.locator('#seal').isVisible(),'seal visible');
      if(stage)ensure(stage.animationName==='none'&&before.animationName==='none','stage and sweep animation none',{stage,before});else ev.liveDependency=dependency;
      await page.locator('#seal').scrollIntoViewIfNeeded();await screenshot(h.surface());
    },{reducedMotion:'reduce'});

  return {liveHero};
}
export async function reference(h) {
 const {id,each,ensure,expect,screenshot,selectedLink,belowBars,navigate,urls,ev,open,clean}=h;
 const page=h.pageProxy, context=h.contextProxy;
      if (id === 'PAGE-009') await each(async () => {
        ensure(await page.title() === 'Hanko API reference', 'exact title');
        ensure(await page.locator('h1').innerText() === 'Was I paid?', 'exact h1');
        ensure((await page.locator('.facts').innerText()).includes('UIVK only (no spend key)'), 'exact key-needed fact');
        ensure(await page.locator('#api a[href="https://hanko-api.201-18-198-162.sslip.io/api/health"]').count() === 1, 'hosted API linked');
        ensure(!(await page.locator('.blocked').allTextContents()).some(t => /hosted.*api/i.test(t)), 'hosted API not marked blocked');
        await screenshot('overview');
      });
      if (id === 'PAGE-010') await each(async () => {
        ensure(await page.locator('#toc a').count() === 12, 'all 12 section links');
        for (const hash of ['overview','quickstart','zcash','crosscheck','reasons','null402','paywall','api','mcp','evidence','tests','trust']) await navigate(hash);
        await screenshot('trust');
      });
      if (id === 'PAGE-011') {
        const spy = async () => {
          await page.evaluate(() => window.scrollTo(0, document.getElementById('null402').offsetTop - (innerWidth <= 900 ? 130 : 76)));
          await expect(selectedLink('null402')).toHaveAttribute('aria-current', 'true');
          if (page.viewportSize().width <= 900) {
            const b = await selectedLink('null402').boundingBox();
            ensure(b.x >= 0 && b.x + b.width <= 375, 'selected mobile section scrolled into view', b);
          }
          await page.evaluate(() => scrollTo(0, 0));
          await expect(selectedLink('overview')).toHaveAttribute('aria-current', 'true');
          await screenshot(page.viewportSize().width <= 900 ? 'mobile-spy' : 'spy');
        };
        await each(spy); await each(spy, { viewport: { width: 375, height: 812 } });
      }
      if (id === 'PAGE-012') await each(async () => {
        const jump = page.getByRole('searchbox', { name: 'Filter the sections' });
        await page.keyboard.press('/'); await expect(jump).toBeFocused();
        await jump.fill('cross');
        const shown = await page.locator('#toc li:not([hidden]) a').allTextContents();
        ensure(shown.length === 1 && shown[0].includes('Cross-check'), 'cross leaves only Cross-check visible', shown);
        await jump.press('Enter'); await expect(page).toHaveURL(/#crosscheck$/); await belowBars('crosscheck');
        await screenshot('cross');
      });
      if (id === 'PAGE-013') await each(async () => {
        const jump = page.getByRole('searchbox', { name: 'Filter the sections' });
        await jump.fill('zzz'); await expect(page.locator('#toc-empty')).toHaveText('No section matches.');
        await expect(page.locator('#toc-empty')).toBeVisible();
        const before = page.url(); await jump.press('Enter'); ensure(page.url() === before, 'Enter with no match leaves location unchanged');
        await screenshot('empty');
        await jump.press('Escape'); await expect(jump).toHaveValue('');
        ensure(await page.locator('#toc li:not([hidden]) a').count() === 12, 'Escape restores all 12 links');
      });
      if (id === 'PAGE-014') await each(async () => {
        const tabs = page.locator('[data-tabs]').first();
        const checkLanguage = async lang => {
          const actual = await page.locator('[data-tabs]').evaluateAll((all, lang) => all.every(t => [...t.querySelectorAll('button')].every(b => b.getAttribute('aria-selected') === String(b.dataset.l === lang))), lang);
          ensure(actual, `all tabs aria-selected ${lang}`);
          ensure(await page.locator('pre[data-lang]').evaluateAll((all, lang) => all.every(p => p.hidden === (p.dataset.lang !== lang)), lang), `all panes switch to ${lang}`);
        };
        for (const lang of ['ts','rust','cli']) { await tabs.locator(`[data-l="${lang}"]`).click(); await checkLanguage(lang); }
        await tabs.locator('[data-l="cli"]').press('ArrowRight'); await checkLanguage('ts'); await expect(tabs.locator('[data-l="ts"]')).toBeFocused();
        await tabs.locator('[data-l="ts"]').press('ArrowLeft'); await checkLanguage('cli'); await expect(tabs.locator('[data-l="cli"]')).toBeFocused();
        await page.reload(); await checkLanguage('cli'); await screenshot('cli');
      });
      if (id === 'PAGE-015') await each(async () => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
        const panes = page.locator('.pane'); ensure(await panes.count() > 15, 'all code panes present', await panes.count());
        for (const lang of ['ts','rust','cli']) {
          await page.locator(`[data-tabs] [data-l="${lang}"]`).first().click();
          for (let i = 0; i < await panes.count(); i++) {
            const pane = panes.nth(i), b = pane.locator('.copy');
            ensure(await b.count() === 1, `pane ${i} has exactly one Copy button`);
            const pre = pane.locator('pre:not([hidden])').first();
            const want = (await pre.innerText()).trim();
            await b.click(); await expect(b).toHaveText('Copied');
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            ensure(copied === want, `pane ${i} copies exact trimmed visible ${lang} text`);
          }
        }
        const b = panes.last().locator('.copy'); await screenshot('copied');
        await expect(b).toHaveText('Copy', { timeout: 2400 });
        ensure(true, 'Copied resets to Copy after the 1600 ms timer');
      });
      if (id === 'PAGE-016') await each(async () => {
        const b = page.locator('.copy').first();
        const want = (await page.locator('.pane').first().locator('pre:not([hidden])').innerText()).trim();
        await b.click(); await expect(b).toHaveText('Copied');
        ensure(await page.evaluate(() => window.__legacy.trim()) === want, 'clipboard rejection offers selected pane through legacy copy');
        await page.evaluate(() => window.__legacyOK = false);
        await b.click(); await expect(b).toHaveText('Selected, press Ctrl+C');
        ensure(await page.evaluate(() => getSelection().toString().trim()) === want, 'both failures leave pane text selected');
        await screenshot('fallback'); await expect(b).toHaveText('Copy', { timeout: 2400 });
      }, {}, () => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('intentional clipboard denial'); } } });
        window.__legacyOK = true;
        const legacy = document.execCommand.bind(document); document.execCommand = command => { window.__legacy = getSelection().toString(); if (!window.__legacyOK) throw new DOMException('Controlled legacy clipboard denial', 'NotAllowedError'); return legacy(command); };
      });
      if (id === 'PAGE-017') await each(async () => {
        const seal = page.locator('#seal');
        await expect(seal).toHaveClass('seal land');
        await expect.poll(() => seal.evaluate(el => getComputedStyle(el).opacity)).toBe('0.94');
        ensure(await seal.evaluate(el => getComputedStyle(el).animationName) === 'press', 'seal press animation');
        const before = await seal.evaluate(el => el.getAnimations().map(a => a.startTime));
        await screenshot('seal');
        await page.locator('#trust').scrollIntoViewIfNeeded(); await page.locator('#seal-pane').scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        ensure(JSON.stringify(await seal.evaluate(el => el.getAnimations().map(a => a.startTime))) === JSON.stringify(before), 'seal does not press again on re-entry');
        ensure(await page.evaluate(() => window.__presses) === 1, 'exactly one seal animationstart');
      }, {}, () => { window.__presses = 0; document.addEventListener('animationstart', e => { if (e.target.id === 'seal' && e.animationName === 'press') window.__presses++; }); });
      if (id === 'PAGE-018') await each(async () => {
        const cross = JSON.parse(await page.locator('[data-json="crosscheck"]').innerText());
        ensure(cross.verdict === 'unverified' && cross.reasons.includes('UNVERIFIED_DISAGREEMENT') && cross.report === null, 'exact recorded unverified disagreement values');
        const text = await page.locator('[data-json="crosscheck"]').innerText();
        for (const endpoint of ['testnet.zec.rocks:443','zec.rocks:443','zaino.testnet.unsafe.zec.rocks:443']) ensure(text.includes(endpoint), `recorded endpoint ${endpoint}`);
        const receipt = await page.locator('[data-json="receipt"]').innerText();
        ensure(/7c1f6cc0[0-9a-f]{52}4c16/.test(receipt), 'receipt names the recorded paywall txid');
        await selectedLink('crosscheck').click(); await screenshot('recorded-crosscheck');
      });
      if (id === 'PAGE-019') await each(async () => {
        const hrefs = await page.locator('a[href^="#"]').evaluateAll(as => as.map(a => a.getAttribute('href').slice(1)));
        for (const hash of hrefs) ensure(await page.locator(`[id="${hash}"]`).count() === 1, `fragment #${hash} has exactly one target`);
        await selectedLink('trust').click(); await page.getByRole('link', { name: 'Hanko, back to the overview' }).click();
        await expect(page).toHaveURL(/#overview$/); await belowBars('overview');
        ensure(await page.locator('.foot a').filter({ hasText: /^overview$/ }).getAttribute('href') === './', 'footer overview returns to ./');
        ensure(await page.locator('.foot a').filter({ hasText: /^source$/ }).getAttribute('href') === 'https://github.com/nickthelegend/zec-payment-verify-sdk', 'footer source targets repo');
        ensure((await page.locator('.foot').innerText()).includes('Copyright (c) 2026 Nivesh Gajengi'), 'exact footer copyright');
      });
      if (id === 'PAGE-020') {
        for (const name of ['live','pages']) {
          try {
            await open(name);
            ensure(await page.getByRole('link', { name: 'Dashboard', exact: true }).getAttribute('href') === 'dashboard/', 'Dashboard same-site href');
            // The raw landing folder contains no dashboard. Exercise its built sibling on Pages.
            if (name === 'local') continue;
            const [r] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.getByRole('link', { name: 'Dashboard', exact: true }).click()]);
            ensure(r.status() === 200 && page.url() === new URL('dashboard/', urls[name]).href, 'Dashboard opens same-site /dashboard/ with HTTP 200');
            await expect(page.locator('h1')).toHaveText(name === 'pages' ? 'Is this proof a payment to me?' : 'Was I paid?');
            ensure(true, `${name} exact dashboard initial rail`);
            if (name === 'pages') await expect(page.getByRole('status')).toHaveText('Fuji, straight from this browser');
            else await expect(page.getByRole('status')).toHaveText('verify API reachable', { timeout: 18000 });
            // Never record form values, DOM dumps, screenshots or response bodies from a console.
          } catch (e) { ev.errors.push({ surface: name, message: clean(e.message) }); }
        }
        ev.note = 'Raw landing folder href verified; Pages sibling console bundled with envDir:false and no gateway. No console form values, response bodies or screenshots collected.';
      }
      if (id === 'EDGE-014') await each(async () => {
        const state = await page.locator('#seal').evaluate(el => ({ class: el.getAttribute('class'), opacity: getComputedStyle(el).opacity, animation: getComputedStyle(el).animationName, bleed: getComputedStyle(el.querySelector('.bleed')).display }));
        ensure(!state.class.includes('armed') && state.opacity === '0.94' && state.animation === 'none' && state.bleed === 'none', 'reduced-motion seal visible .94, unarmed, no press or bleed', state);
        await screenshot('reduce'); await navigate('null402'); await navigate('overview');
      }, { reducedMotion: 'reduce' });
      if (id === 'EDGE-016') await each(async () => {
        await page.keyboard.press('Tab'); const skip = page.getByRole('link', { name: 'Skip to the reference' });
        await expect(skip).toBeFocused(); await expect(skip).toBeInViewport();
        await screenshot('skip'); await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/#overview$/); await belowBars('overview');
        await expect(page.locator('h1')).toBeInViewport();
      });
      if (id === 'EDGE-019') await each(async () => {
        ensure(await page.evaluate(() => document.documentElement.scrollWidth === 375), '375px no horizontal page scroll', await page.evaluate(() => document.documentElement.scrollWidth));
        await expect(page.locator('.jump')).toBeHidden();
        const panes = page.locator('.pane');
        for (let i = 0; i < await panes.count(); i++) {
          const pane = panes.nth(i); await pane.scrollIntoViewIfNeeded();
          const [b,p,t] = await Promise.all([pane.locator('.copy').boundingBox(),pane.boundingBox(),pane.locator('.pane-title').boundingBox()]);
          ensure(b.x >= p.x + 4 && b.x + b.width <= p.x + p.width - 4 && b.x >= t.x + t.width - 0.5, `pane ${i} Copy fits without title overlap`, { button:b,pane:p,title:t });
        }
        for (const hash of ['overview','quickstart','zcash','crosscheck','reasons','null402','paywall','api','mcp','evidence','tests','trust']) await navigate(hash);
        ensure(await page.evaluate(() => document.documentElement.scrollWidth === 375), 'no horizontal page scroll after navigation');
        await screenshot('mobile-trust'); await navigate('overview'); await screenshot('mobile-overview');
      }, { viewport: { width: 375, height: 812 } });

}

import { test } from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const payment={id:'payment-fixture',merchant_id:'merchant-fixture',status:'pending',amount:'10.0000000',asset:'XLM',destination_address:'G'+'A'.repeat(55),memo:'Invoice <test>',expires_at:'2027-01-01T00:00:00Z',created_at:'2026-10-21T00:00:00Z'};

test('issue_765 invoice browser regression', async ({page}) => {
 const errors=[]; const calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  calls.push({url:url.href,headers:route.request().headers()});
  if(url.pathname.startsWith('/v1/')){
   let data={};
   if(url.pathname==='/v1/payments') data={payments:[payment]};
   else if(url.pathname==='/v1/payments/payment-fixture') data=payment;
   else if(url.pathname.endsWith('/webhooks')) data={deliveries:[]};
   else if(url.pathname.endsWith('/summary')) data={};
   else if(url.pathname.includes('/keys')) data={keys:[]};
   return route.fulfill({json:data});
  }
  if(url.pathname==='/') return route.fulfill({body:'test',contentType:'text/plain'});
  if(url.pathname==='/ready') return route.fulfill({json:{status:'ok'}});
  const name=({'/dashboard':'dashboard.html','/dashboard/app.js':'dashboard.js','/dashboard/app.css':'dashboard.css','/dashboard/theme.js':'dashboard-theme.js','/dashboard/admin':'admin.html'})[url.pathname]||url.pathname.replace('/dashboard/','');
  const dir=root;
  const path=dir+'/static/'+name;
  if(!fs.existsSync(path)) return route.fulfill({status:404,body:'not found'});
  return route.fulfill({body:fs.readFileSync(path),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
 });

 await page.goto('http://localhost/dashboard');
 await page.locator('#api-key').fill('fixture-merchant-key');
 await page.locator('#gate-form button[type="submit"]').click();
 await page.locator('#rows tr').first().click();
 await page.locator('#invoice-print:not([disabled])').waitFor();
 assert.equal(await page.locator('#invoice-fields').innerText().then(s=>s.includes('Invoice <test>')),true);
 assert.equal(await page.locator('#invoice-qr svg').count(),1);
 assert.ok((await page.locator('#invoice-uri').innerText()).includes('destination='));
 await page.evaluate(()=>{window.print=()=>{window.didPrint=true;};});
 await page.locator('#invoice-print').click();
 assert.equal(await page.evaluate(()=>window.didPrint),true);
 await page.emulateMedia({media:'print'});
 assert.equal(await page.locator('#payment-invoice').isVisible(),true);
 for(const sel of ['.topbar','.toolbar','#detail-fields','#deliveries','#invoice-print']) assert.equal(await page.locator(sel).first().isVisible(),false,sel);
 
 
 assert.ok(!calls.some(c=>/x-admin-secret/i.test(JSON.stringify(c.headers))));
 assert.ok(!calls.some(c=>c.url.includes('fixture-merchant-key')));
 assert.deepEqual(errors,[]);
 await page.emulateMedia({media:'screen'});

});

import { test } from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const payment={id:'payment-fixture',merchant_id:'merchant-fixture',status:'pending',amount:'10.0000000',asset:'XLM',destination_address:'G'+'A'.repeat(55),memo:'Invoice <test>',expires_at:'2027-01-01T00:00:00Z',created_at:'2026-10-21T00:00:00Z'};

test('issue_766 admin browser regression', async ({page}) => {
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
   else if(url.pathname.includes('/keys')) data=route.request().method()==='POST'?{api_key:'fixture-issued-key'}:{keys:[{key_id:'key-one',prefix:'sg_test',label:'Primary',active:true}]};
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

 await page.goto('http://localhost/dashboard/admin');
 await page.locator('#admin-secret').fill('fixture-admin-secret');
 await page.locator('#admin-form button').click();
 await page.locator('#merchant-id').fill('fixture-merchant');
 await page.locator('#merchant-form button').click();
 await page.locator('#issue-form').waitFor({state:'visible'});
 assert.ok(calls.some(c=>c.headers['x-admin-secret']==='fixture-admin-secret'));
 await page.locator('#key-label').fill('Replacement');
 await page.locator('#issue-form button').click();
 await page.locator('#new-key').waitFor({state:'visible'});
 assert.ok((await page.locator('#new-key').innerText()).includes('fixture-issued-key'));
 await page.locator('#hide-key').click();
 assert.equal(await page.locator('#new-key').innerText(),'');
 page.once('dialog',dialog=>dialog.accept());
 await page.locator('#admin-output button').click();
 await page.waitForFunction(()=>document.getElementById('admin-status').textContent.startsWith('1 keys'));
 assert.ok(calls.some(c=>c.url.endsWith('/keys/key-one')));
 assert.ok(!(await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]))).includes('fixture-admin-secret'));
 await page.locator('#admin-sign-out').click();
 assert.equal(await page.locator('#admin-gate').isVisible(),true);
 assert.deepEqual(errors,[]);

});

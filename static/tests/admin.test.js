import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../admin.js', import.meta.url), 'utf8');
test('issue_766 admin credential stays in memory and requests are isolated', async () => {
 const elements = new Map(); const events = {}; const calls = [];
 const element = id => { if (!elements.has(id)) elements.set(id, { value:'', hidden:false, textContent:'', children:[], handlers:{}, focus(){}, replaceChildren(){this.children=[];}, appendChild(x){this.children.push(x);}, addEventListener(k,v){this.handlers[k]=v;} }); return elements.get(id); };
 vm.runInNewContext(source, { document: { getElementById:element, querySelectorAll:()=>[], createElement:()=>element(Symbol()) }, window:{ addEventListener:(k,v)=>events[k]=v, confirm:()=>true }, fetch: async (url, options) => { calls.push({url,options}); return {ok:true,status:200,json:async()=>({keys:[]})}; } });
 element('admin-secret').value='fixture-admin-secret';
 element('admin-form').handlers.submit({preventDefault(){}});
 assert.equal(element('admin-secret').value,'');
 element('merchant-id').value='merchant/one';
 element('merchant-form').handlers.submit({preventDefault(){}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls[0].url,'/v1/merchants/merchant%2Fone/keys');
 assert.equal(calls[0].options.headers['X-Admin-Secret'],'fixture-admin-secret');
 assert.equal(calls[0].options.headers.Authorization,undefined);
 assert.equal(calls[0].options.redirect,'error');
 events.pagehide();
 assert.equal(element('admin-app').hidden,true);
 assert.equal(element('admin-output').children.length,0);
 assert.ok(!/localStorage|sessionStorage|console\./.test(source));
});
test('issue_766 merchant module graph never sends the admin header', () => {
 for (const file of ['dashboard.js','session.js','state.js','keys.js','format.js']) {
  const js=readFileSync(new URL('../'+file,import.meta.url),'utf8');
  assert.ok(!/x-admin-secret|admin\.js/i.test(js),file);
 }
});

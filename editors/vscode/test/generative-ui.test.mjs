import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {buildSync} from 'esbuild';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const here=fileURLToPath(new URL('.',import.meta.url));
const bundled=buildSync({entryPoints:[here+'../src/markdown.ts'],bundle:true,format:'cjs',write:false,platform:'node'}).outputFiles[0].text;
const module={exports:{}};
new Function('module','exports','require',bundled)(module,module.exports,createRequire(import.meta.url));
const markdown=module.exports;
const fence=(payload)=>'```dgc-ui\n'+JSON.stringify(payload)+'\n```';

test('one bounded card renders metrics, progress, chart, table and send choices',()=>{
 const html=markdown.render(fence({version:'1',title:'ERP health',subtitle:'Current run',blocks:[
  {type:'metrics',items:[{label:'Open alerts',value:'2',detail:'One needs review'}]},
  {type:'steps',items:[{label:'Audit',state:'done'},{label:'Pip review',state:'attention'}]},
  {type:'bars',items:[{label:'Mon',value:4},{label:'Tue',value:8}]},
  {type:'table',columns:['Service','State'],rows:[['ERP','Healthy']]},
  {type:'choices',items:[{label:'Review alert',description:'Open a follow-up',reply:'Review the ERP alert.'}]}
 ]}));
 assert.match(html,/class="genui-card"/);
 assert.match(html,/M32 24 L20 30 L13 72 L25 66 Z/);
 assert.match(html,/Open alerts/);
 assert.match(html,/height:100%/);
 assert.match(html,/data-genui-send="Review the ERP alert\."/);
 assert.match(html,/One click sends the request/);
 assert.doesNotMatch(html,/<script|<iframe|onclick=/i);
});

test('a real ERP-style answer with six metrics and six steps renders as a card',()=>{
 const html=markdown.render(fence({version:'1',title:'ERP status',subtitle:'Verified live',blocks:[
  {type:'metrics',items:Array.from({length:6},(_,i)=>({label:`Metric ${i+1}`,value:String(i+1),detail:'Verified'}))},
  {type:'steps',label:'Workstreams',items:Array.from({length:6},(_,i)=>({label:`Step ${i+1}`,state:i===4?'attention':'done',detail:'Checked'}))},
  {type:'choices',label:'Next',items:[{label:'Review',description:'Prepare a follow-up',reply:'Review the blocker'}]}
 ]}));
 assert.match(html,/class="genui-card"/);
 assert.equal((html.match(/class="genui-metric"/g)||[]).length,6);
 assert.equal((html.match(/class="genui-step-dot"/g)||[]).length,6);
 assert.doesNotMatch(html,/class="code"/);
});

test('model text is escaped and invalid or oversized payloads remain inert code',()=>{
 const html=markdown.render(fence({version:'1',title:'<img src=x onerror=alert(1)>',blocks:[
  {type:'choices',items:[{label:'" onmouseover="alert(1)',reply:'<script>alert(1)</script>'}]}
 ]}));
 assert.match(html,/&lt;img/);
 assert.match(html,/&lt;script&gt;/);
 assert.doesNotMatch(html,/<img|<script|onmouseover="alert/i);
 assert.match(markdown.render(fence({version:'1',title:'Unsafe',blocks:[{type:'choices',items:[{label:'Clear tasks',reply:'/todo clear'}]}]})),/class="code"/);
 assert.match(markdown.render('```dgc-ui\n{"blocks":[]}\n```'),/class="code"/);
 assert.match(markdown.render('```dgc-ui\n'+ 'x'.repeat(17000)+'\n```'),/class="code"/);
});

test('tool summaries use real test runner counts and ignore unrelated prose',()=>{
 const context={window:{}};
 vm.runInNewContext(readFileSync(here+'../media/tool-insights.js','utf8'),context);
 const parse=context.window.DgcToolInsights.testCounts;
 assert.deepEqual({...parse('7 passed, 1 failed, 2 skipped in 2.4s')},{total:10,passed:7,failed:1,skipped:2});
 assert.deepEqual({...parse('# tests 8\n# pass 7\n# fail 1\n# skipped 0')},{total:8,passed:7,failed:1,skipped:0});
 assert.equal(parse('The user passed by one failed test case in a story.'),null);
});

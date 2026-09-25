import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeDom} from './support/webview-dom.mjs';

test('chat hides withdrawn offers and routes old installations to settings for removal', () => {
  const x = makeDom({clock:true});
  const items = [
    {name:'allowed',display_name:'Allowed package',installed:true},
    {name:'blocked',display_name:'Blocked package',install:'block'},
    {name:'old',display_name:'Old package',installed:true,install:'block'},
    {name:'private',display_name:'Private package',license:'Proprietary'},
  ];
  x.send({type:'event',event:{type:'plugin_catalog',items}});
  assert.equal(x.doc.querySelector('.plugin-row'),null);
  x.doc.querySelector('#open-plugins').click();
  x.send({type:'event',event:{type:'plugin_catalog',items}});
  assert.deepEqual([...x.doc.querySelectorAll('.plugin-row strong')].map(e=>e.textContent),['Allowed package']);
  x.doc.querySelector('[data-plugin-pane=installed]').click();
  assert.deepEqual([...x.doc.querySelectorAll('.plugin-row strong')].map(e=>e.textContent),['Allowed package']);
  x.doc.querySelector('#plugin-removals').click();
  assert.equal(x.posted.at(-1).type,'openSettings');
  assert.equal(x.posted.at(-1).section,'plugins');
  assert.equal(x.errors.length,0);
});

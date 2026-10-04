import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeDom} from './support/webview-dom.mjs';

// The latest extension removed its duplicate chat catalog. Package browsing,
// withdrawn offers and uninstall now belong to the standalone Settings client.
test('catalog refresh cannot expose a second plugin browser or install controls in chat', () => {
  const x = makeDom({clock:true});
  try {
    const items = [
      {name:'allowed',display_name:'Allowed package',installed:true},
      {name:'blocked',display_name:'Blocked package',install:'block'},
      {name:'old',display_name:'Old package',installed:true,install:'block'},
      {name:'private',display_name:'Private package',license:'Proprietary'},
    ];
    x.send({type:'event',event:{type:'plugin_catalog',items}});
    assert.equal(x.doc.querySelector('.plugin-row,#open-plugins,[data-plugin-install]'),null);
    assert.equal(x.doc.querySelector('#surface').hidden,true);
    x.doc.querySelector('#btn-settings').click();
    assert.equal(x.posted.at(-1).type,'openSettings');assert.deepEqual(Object.keys(x.posted.at(-1)),['type']);
    x.send({type:'event',event:{type:'plugin_catalog',items}});
    assert.equal(x.doc.querySelector('#surface').hidden,true);
    assert.equal(x.doc.querySelector('.plugin-row,[data-plugin-install]'),null);
    assert.equal(x.posted.some(m=>m.type==='installPlugin'),false);
    assert.deepEqual(x.errors,[]);
  }finally{x.dom.window.close();}
});

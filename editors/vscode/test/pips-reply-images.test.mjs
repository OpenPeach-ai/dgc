import {test} from 'node:test';
import assert from 'node:assert/strict';
import {messageMarkup} from '../src/pipsTranscript.js';

// A Pip's reply shows the images it made (generate_image, Pips keep them as a sent photo is kept), below its words,
// each asked for by message and index the way a sent photo is.
const options={name:'Studio',formatDate:()=>'',renderMarkdown:t=>`<p>${t}</p>`,prompt:'',canSend:false,imageSrc:()=>''};

test("a Pip's reply shows the images it made, after its words",()=>{
  const html=messageMarkup({id:'message_a',role:'assistant',text:"Here's your fox.",images:[{index:0,mime:'image/png',bytes:245081}]},options);
  assert.match(html,/data-message-image="message_a:0"/);
  assert.ok(html.indexOf("Here's your fox.")<html.indexOf('msg-images'),'the picture comes after what it said');
});

test('a reply without images is as before, and a sent photo still shows',()=>{
  assert.doesNotMatch(messageMarkup({id:'message_b',role:'assistant',text:'Done.'},options),/msg-images/);
  assert.match(messageMarkup({id:'message_c',role:'user',text:'(sent an image)',images:[{index:0,mime:'image/png',bytes:9}]},options),/data-message-image="message_c:0"/);
});

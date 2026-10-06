import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replyParts} from '../src/pipsTranscript.js';

// A Pip's reply reads like a messaging app: one short bubble per paragraph. A code block or a list
// stays whole, and a long reply never becomes a wall of bubbles.
test('paragraphs become separate bubbles',()=>{
 assert.deepEqual(replyParts("Hi there! I'm Gmail.\n\nGmail isn't connected yet.\n\n\nWant to connect it now?"),
  ["Hi there! I'm Gmail.","Gmail isn't connected yet.","Want to connect it now?"]);
 assert.deepEqual(replyParts('One line only.'),['One line only.']);
 assert.deepEqual(replyParts('  \n\n  '),[]);
});
test('a code block stays in one bubble, blank lines and all',()=>{
 const code='Here it is:\n\n```py\nimport os\n\nprint(os.getcwd())\n```\n\nThat prints the folder.';
 assert.deepEqual(replyParts(code),['Here it is:','```py\nimport os\n\nprint(os.getcwd())\n```','That prints the folder.']);
});
test('a loose list stays together',()=>{
 assert.deepEqual(replyParts('Three things:\n\n- one\n\n- two\n\n1. three\n\nDone.'),['Three things:','- one\n\n- two\n\n1. three','Done.']);
});
test('a long reply is at most eight bubbles, nothing lost',()=>{
 const parts=replyParts(Array.from({length:12},(_,i)=>'Paragraph '+i).join('\n\n'));
 assert.equal(parts.length,8);assert.match(parts[7],/Paragraph 7[\s\S]*Paragraph 11/);
});

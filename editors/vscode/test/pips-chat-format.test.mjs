import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replyParts} from '../src/pipsTranscript.js';

// A Pip's reply reads the way the Pip means it to (pip_chat.BUBBLES): one bubble, or the short messages it parts with
// a line of just ---. Asked 2026-11-03: "leave this to the llm model to decide". A long reply never becomes a wall of
// bubbles.
test('with no --- a reply is one bubble, whatever its paragraphs',()=>{
 const four='First thought.\n\nSecond thought.\n\nThird thought.\n\nFourth thought.';
 assert.deepEqual(replyParts(four),[four]);
 const poem=[1,2,3,4].map(n=>`Stanza ${n}, line one\nstanza ${n}, line two`).join('\n\n');
 assert.deepEqual(replyParts(poem),[poem],'a poem in four stanzas is one piece');
 assert.deepEqual(replyParts('One line only.'),['One line only.']);
 assert.deepEqual(replyParts('  \n\n  '),[]);
});
test('a line of just --- parts the short messages the Pip means, and is not shown',()=>{
 assert.deepEqual(replyParts("Hi there! I'm Gmail.\n---\nGmail isn't connected yet.\n\n  ---  \n\nWant to connect it now?"),
  ["Hi there! I'm Gmail.","Gmail isn't connected yet.",'Want to connect it now?']);
 assert.deepEqual(replyParts('---\nOnly this.\n---\n\n---\n'),['Only this.'],'an empty part is dropped');
 assert.deepEqual(replyParts('Not a break: ---\n----\n- -'),['Not a break: ---\n----\n- -'],'only a line of exactly ---');
});
test('a --- in a code block is code, and the block stays whole',()=>{
 const code='Here it is:\n\n```yaml\nname: a\n---\nname: b\n\nend: c\n```\n---\nThat makes two documents.';
 assert.deepEqual(replyParts(code),['Here it is:\n\n```yaml\nname: a\n---\nname: b\n\nend: c\n```','That makes two documents.']);
});
test('a list stays as it is',()=>{
 assert.deepEqual(replyParts('Three things:\n\n- one\n\n- two\n\n1. three\n\nDone.'),['Three things:\n\n- one\n\n- two\n\n1. three\n\nDone.']);
});
test('a long reply is at most eight bubbles, nothing lost',()=>{
 const parts=replyParts(Array.from({length:12},(_,i)=>'Message '+i).join('\n---\n'));
 assert.equal(parts.length,8);assert.match(parts[7],/Message 7[\s\S]*Message 11/);assert.doesNotMatch(parts[7],/---/);
});

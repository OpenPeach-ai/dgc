import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

test("replayed decisions are settled, escape notes, and leave denied commands marked denied", () => {
  const s = makeDom();
  const note = 'Denied · note for the model: <img src=x onerror="bad()">';
  s.send({ type: "event", event: { type: "history", items: [
    { type: "turn_start", turn_id: "saved", prompt: "Run this command" },
    { type: "tool_call", call_id: "bash-1", name: "bash", args: { command: "echo example" }, summary: "echo example" },
    { type: "permission_decision", call_id: "bash-1", name: "bash",
      args: { command: "echo example" }, decision: "no", message: note },
    { type: "tool_denied", call_id: "bash-1", name: "bash", reason: note },
    { type: "turn_end", turn_id: "saved", reason: "completed" },
  ] } });
  const card = s.doc.querySelector('.card[data-history-approval="true"]');
  assert.ok(card?.classList.contains("resolved"));
  assert.equal(card.querySelector(".decision").textContent, note);
  assert.equal(card.querySelector("img"), null);
  assert.equal(card.querySelectorAll("button, textarea").length, 0);
  assert.equal(card.hasAttribute("data-request-id"), false);
  assert.equal(s.doc.querySelector('[data-tool-name="bash"]').dataset.status, "denied");
  assert.doesNotMatch(s.doc.querySelector('[data-tool-name="bash"] .verb').textContent, /^Ran/);
  assert.match(s.doc.querySelector('.tool-group-label').textContent, /^No tools ran/);
  assert.equal(s.posted.some(m => m.type === "permission_response"), false);
  assert.deepEqual(s.errors, []);
});

test("a resolved live permission becomes a folded receipt without re-running the action",()=>{
 const s=makeDom(),event=value=>s.send({type:'event',event:value});
 event({type:'turn_start',turn_id:'one',prompt:'Inspect'});
 event({type:'permission_request',id:'permission1',name:'read_file',args:{path:'example.txt'},summary:'Read example'});
 const card=s.doc.querySelector('.card[data-request-id="permission1"]');assert.ok(card);assert.equal(card.querySelector('details'),null);
 card.querySelector('[data-d="once"]').click();
 const receipt=card.querySelector('.permission-receipt');assert.ok(receipt);assert.equal(receipt.open,false);
 assert.match(receipt.querySelector('summary').textContent,/read_file.*Allowed once/);
 assert.equal(s.posted.filter(m=>m.type==='permission_response').length,1);
 receipt.open=true;receipt.open=false;
 assert.equal(s.posted.filter(m=>m.type==='permission_response').length,1);
 assert.ok([...card.querySelectorAll('button,textarea')].every(c=>c.disabled));
 assert.deepEqual(s.errors,[]);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:[new URL('../src/appConnectors.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs'});
const mod={exports:{}};new Function('module','exports',bundle.outputFiles[0].text)(mod,mod.exports);
const {connectorUrl,APP_CONNECTORS}=mod.exports;
test('provider URL policy matches the documented setup methods',()=>{
 for(const [id,def] of Object.entries(APP_CONNECTORS)){
  // Docusign has an endpoint per account kind (developer, production) instead of one.
  const urls=def.environments?Object.values(def.environments).map(e=>e.url):[def.url||def.placeholder];
  for(const url of urls)assert.equal(connectorUrl(id,url),url);
 }
 assert.throws(()=>connectorUrl('docusign','https://mcp.docusign.com.evil.example/mcp'),/published connector endpoints/);
 assert.throws(()=>connectorUrl('asana','https://mcp.asana.com/sse'),/published connector endpoint/);
 assert.equal(connectorUrl('n8n','http://127.0.0.1:5678/mcp-server/http'),'http://127.0.0.1:5678/mcp-server/http');
 for(const [id,url] of [['zapier','https://evil.example/api/v1/connect'],['make','https://mcp.make.com.evil.example'],['n8n','http://team.n8n.cloud/mcp-server/http'],['n8n','https://user:password@example.com/mcp-server/http'],['n8n','https://example.com/mcp-server/http?token=private'],['n8n','https://example.com/mcp-server/http#secret'],['n8n','https://example.com\\/mcp-server/http'],['arcade','https://api.arcade.dev:8443/mcp/id'],['arcade','https://api.arcade.dev/mcp/'],['arcade','https://api.arcade.dev.evil.example/mcp/id']])assert.throws(()=>connectorUrl(id,url),undefined,url);
});

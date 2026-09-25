/** Provider-owned setup. Public descriptions are shared with the Python package. */
export type AppConnector = { name: string; kind: string; url: string; auth: string[];
  manage: string; docs: string; terms: string; privacy: string; summary: string;
  setup: string; placeholder: string; license: string };
export const APP_CONNECTORS: Record<string, AppConnector> = require('../../../dgc/connector_catalog.json');
export function connectorUrl(id: string, input: unknown): string {
  const def = APP_CONNECTORS[id];
  if (!def) throw new Error('Unknown app connector');
  const raw = String(input || def.url).trim();
  if (raw.length > 4096 || /[\x00-\x20\x7f\\]/.test(raw)) throw new Error('Enter a valid connector URL');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Enter a valid connector URL'); }
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(id === 'n8n' && loopback && url.protocol === 'http:')))
    throw new Error('Use HTTPS (or loopback HTTP for n8n), without credentials or query parameters');
  if (def.url && url.href.replace(/\/$/,'') !== def.url.replace(/\/$/,''))
    throw new Error('Use the published connector endpoint');
  if (id === 'arcade' && (url.hostname !== 'api.arcade.dev' || url.port || !/^\/mcp\/[^/]+/.test(url.pathname)))
    throw new Error('Paste an Arcade Cloud gateway URL from api.arcade.dev/mcp/');
  if (id === 'n8n' && !url.pathname.replace(/\/$/,'').endsWith('/mcp-server/http'))
    throw new Error('Paste the n8n MCP URL ending in /mcp-server/http');
  return url.href;
}

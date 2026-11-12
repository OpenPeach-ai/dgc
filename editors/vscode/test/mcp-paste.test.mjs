// pips-09: Settings → MCP servers → Add server reads what a person pastes (a URL, a `claude mcp add` command, a
// server's JSON) into the form's fields. Nothing is saved or run by reading it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpPaste, words, nameFromUrl } from '../src/mcpPaste.js';

test('a server URL: a remote server named from its address', () => {
  assert.deepEqual(parseMcpPaste('  https://mcp.notion.com/mcp  '),
    { name: 'notion', transport: 'remote', target: 'https://mcp.notion.com/mcp', args: [], env: [], token: '' });
  assert.equal(nameFromUrl('https://api.githubcopilot.com/mcp/'), 'githubcopilot');
});

test('claude mcp add with a URL, a transport, a scope and a bearer header', () => {
  const got = parseMcpPaste('claude mcp add --transport http --scope user -H "Authorization: Bearer sk_live_123" linear https://mcp.linear.app/mcp');
  assert.deepEqual(got, { name: 'linear', transport: 'remote', target: 'https://mcp.linear.app/mcp', args: [], env: [], token: 'sk_live_123' });
  const other = parseMcpPaste('claude mcp add -t sse -H "X-Api-Key: abc" stripe https://mcp.stripe.com');
  assert.equal(other.token, '');
  assert.match(other.note, /X-Api-Key was left out/);
});

test('claude mcp add with a command, its arguments and environment, after --', () => {
  assert.deepEqual(parseMcpPaste('claude mcp add -e API_KEY=abc --env=DEBUG=1 airtable -- npx -y airtable-mcp-server --verbose'),
    { name: 'airtable', transport: 'stdio', target: 'npx', args: ['-y', 'airtable-mcp-server', '--verbose'], env: ['API_KEY=abc', 'DEBUG=1'], token: '' });
  assert.deepEqual(parseMcpPaste('claude mcp add files npx @modelcontextprotocol/server-filesystem "/home/me/My Docs"').args,
    ['@modelcontextprotocol/server-filesystem', '/home/me/My Docs']);
});

test('claude mcp add-json and the JSON other apps share', () => {
  assert.deepEqual(parseMcpPaste(`claude mcp add-json weather '{"type":"stdio","command":"/usr/bin/weather","args":["--celsius"],"env":{"KEY":"v"}}'`),
    { name: 'weather', transport: 'stdio', target: '/usr/bin/weather', args: ['--celsius'], env: ['KEY=v'], token: '' });
  assert.deepEqual(parseMcpPaste('{"mcpServers": {"sentry": {"url": "https://mcp.sentry.dev/mcp", "headers": {"Authorization": "Bearer t0k"}}}}'),
    { name: 'sentry', transport: 'remote', target: 'https://mcp.sentry.dev/mcp', args: [], env: [], token: 't0k' });
});

test('anything else is refused in plain words, never half read', () => {
  for (const [text, words_] of [['', /Paste a server URL/], ['rm -rf /', /claude mcp add command/], ['claude mcp add', /names no server/],
    ['claude mcp add notion', /no URL or command/], ['claude mcp add --transport http x ./run.sh', /needs a URL/],
    ['claude mcp add --frobnicate x https://a.example', /doesn't know --frobnicate/], ['claude mcp add "x https://a.example', /never closed/],
    ['{not json', /couldn't be read/], ['{"mcpServers": {"x": {}}}', /neither a URL nor a command/]]) {
    assert.throws(() => parseMcpPaste(text), (e) => words_.test(e.message), text);
  }
  assert.equal(parseMcpPaste('claude mcp add "Bad Name!" https://a.example/mcp').name, 'Bad-Name-');
  assert.deepEqual(words(`a 'b c' "d \\"e\\"" f\\ g`), ['a', 'b c', 'd "e"', 'f g']);
});

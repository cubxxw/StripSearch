// Package compatibility smoke only; not a StripSearch MCP server.
// Official patterns: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-server.md
// https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-client.md
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

if (process.argv.includes('--server')) {
  await serveStdio(() => {
    const server = new McpServer({ name: 'stripsearch-compat-probe', version: '0.0.0' });
    server.registerTool('probe_echo', {
      description: 'Synthetic local echo; no research or provider access.',
      inputSchema: z.object({ value: z.number().int() }),
      outputSchema: z.object({ value: z.number().int(), synthetic: z.literal(true) }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    }, async ({ value }) => {
      const data = { value, synthetic: true };
      return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    });
    server.registerResource('fixture', 'stripsearch-probe://fixture', { mimeType: 'application/json' },
      async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"synthetic":true}' }] }));
    return server;
  });
} else {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  let sqliteVersion;
  try {
    sqliteVersion = db.prepare('select sqlite_version() as version').get().version;
    db.exec('CREATE TABLE revisions (id INTEGER PRIMARY KEY, current INTEGER NOT NULL)');
    db.prepare('INSERT INTO revisions VALUES (?, ?)').run(1, 1);
    const faultyUpdate = db.transaction(() => {
      db.prepare('UPDATE revisions SET current = 0').run();
      db.prepare('INSERT INTO revisions VALUES (?, ?)').run(1, 1);
    });
    assert.throws(faultyUpdate);
    assert.equal(db.prepare('SELECT current FROM revisions WHERE id = 1').get().current, 1);
  } finally { db.close(); }

  const receipts = [];
  for (const generation of ['v2', 'v1']) {
    const { Client } = await import(generation === 'v2' ? '@modelcontextprotocol/client' : 'mcp-v1/client/index.js');
    const { StdioClientTransport } = await import(generation === 'v2' ? '@modelcontextprotocol/client/stdio' : 'mcp-v1/client/stdio.js');
    const client = new Client({ name: `compat-${generation}`, version: '0.0.0' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(import.meta.url), '--server'] }));
      const { tools } = await client.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'probe_echo');
      assert.ok(tools[0].inputSchema.required.includes('value'));
      assert.ok(tools[0].outputSchema);
      const result = await client.callTool({ name: 'probe_echo', arguments: { value: 7 } });
      assert.deepEqual(result.structuredContent, { value: 7, synthetic: true });
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      const invalid = await client.callTool({ name: 'probe_echo', arguments: { value: 'bad' } });
      assert.equal(invalid.isError, true);
      const resource = await client.readResource({ uri: 'stripsearch-probe://fixture' });
      assert.deepEqual(JSON.parse(resource.contents[0].text), { synthetic: true });
      receipts.push({ client: generation, initialize: 'pass', tools_list: 'pass', structured_content: 'pass', invalid_input: 'rejected', resource_read: 'pass' });
    } finally { await client.close(); }
  }
  console.log(JSON.stringify({ node: process.version, sqlite: sqliteVersion, transaction_rollback: 'pass', clients: receipts,
    limitations: ['Package smoke, not two real MCP hosts.', 'No StripSearch tools, model, provider or semantic evaluation.'] }, null, 2));
}

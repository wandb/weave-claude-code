// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { startTestDaemon } from './helpers.ts';

test('the daemon exports Forge spans to the configured OTLP endpoint', async () => {
  const requests: { url: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
    res.setHeader('content-type', 'application/x-protobuf');
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const daemon = await startTestDaemon({ env: {
    WANDB_API_KEY: 'wire-test-key',
    WEAVE_PROJECT: 'test/test',
    WF_TRACE_SERVER_URL: `http://127.0.0.1:${address.port}`,
  } });
  try {
    const session_id = 'forge-wire';
    const transcript_path = join(daemon.home, '.claude', 'projects', 'test', `${session_id}.jsonl`);
    mkdirSync(dirname(transcript_path), { recursive: true });
    writeFileSync(transcript_path, '');
    await daemon.send({ hook_event_name: 'SessionStart', session_id, transcript_path, source: 'startup' });
    await daemon.send({ hook_event_name: 'UserPromptSubmit', session_id, prompt: 'test tracing' });
    await daemon.send({ hook_event_name: 'PreToolUse', session_id,
      tool_use_id: 'wire-tool', tool_name: 'Read', tool_input: { file_path: '/example' } });
    await daemon.send({ hook_event_name: 'PostToolUse', session_id,
      tool_use_id: 'wire-tool', tool_name: 'Read', tool_input: { file_path: '/example' }, tool_response: 'hello' });
    await daemon.send({ command: 'shutdown' });
    assert.equal(await daemon.waitForExit(5000), true, daemon.readLog());
    assert.ok(requests.length > 0, daemon.readLog());
    for (const request of requests) {
      assert.equal(request.url, '/agents/otel/v1/traces');
      assert.equal(request.headers['wandb-api-key'], 'wire-test-key');
      assert.equal(request.headers.project_id, 'test/test');
      assert.ok(request.body.includes(Buffer.from('forge-integration')));
      assert.ok(request.body.includes(Buffer.from('weave.sdk.name')));
    }
    assert.doesNotMatch(daemon.readLog(), /Error flushing|OTLPExporterError/);
  } finally {
    await daemon.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

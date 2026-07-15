// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// The daemon captures instruction files from the InstructionsLoaded hook and
// stamps them on every turn root as `gen_ai.system_instructions`. The hook
// carries only file_path (not the contents), so the daemon reads each file from
// disk — these tests write real files and let the daemon read them back. The
// hook fires per file, and its order relative to SessionStart is NOT guaranteed
// (verified in daemon logs: a file can load before SessionStart), so
// instructions arriving before the session exists are buffered and drained when
// the session is created. These tests drive the real routeEvent entry point (as
// production does) so buffering, draining, dedup, and per-turn stamping are all
// exercised end-to-end against the exported spans (the public contract).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { GlobalDaemon } from '../src/daemon.ts';
import { ATTR, IntegrationBaggageSpanProcessor } from '../src/genaiSpans.ts';

// Production installs this via NodeTracerProvider.register(); the test injects a
// BasicTracerProvider, so set it up here or context.with won't propagate.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

function setupTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new IntegrationBaggageSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

function makeDaemon(tracer: unknown) {
  const logFile = path.join(os.tmpdir(), `wcp-sysinstr-${process.pid}.log`);
  const d = new GlobalDaemon('/tmp/unused-sysinstr.sock', logFile, 'e/p', 'k', 'https://x', false, 'claude-code');
  (d as unknown as { tracer: unknown }).tracer = tracer;
  return d as unknown as { routeEvent(p: Record<string, unknown>): Promise<void> };
}

/** Seed a transcript file with a single user line (the first line carries the
 *  CC CLI version, as real transcripts do) and return its path. */
function seedTranscript(sid: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-sysinstr-'));
  const file = path.join(dir, `${sid}.jsonl`);
  const userLine = { type: 'user', version: '1.2.3', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
  fs.writeFileSync(file, JSON.stringify(userLine) + '\n');
  return { dir, file };
}

/** Build an InstructionsLoaded payload the way Claude Code does: content-free,
 *  carrying only the path. `content` is written to a real file under `dir` keyed
 *  by `logicalPath`, so re-loading the same logical path rewrites the same file
 *  (exercising dedup) and the daemon reads the content back from disk. */
function makeInstructionsLoader(dir: string) {
  return (sid: string, logicalPath: string, content: string, loadReason: string) => {
    const filePath = path.join(dir, logicalPath.replace(/[/\\]/g, '_'));
    fs.writeFileSync(filePath, content);
    return { hook_event_name: 'InstructionsLoaded', session_id: sid, file_path: filePath, load_reason: loadReason };
  };
}

function turnRoots(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter((s) => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
}

test('buffers InstructionsLoaded fired before SessionStart, then accumulates in load order', async () => {
  const sid = 'sess-order';
  const { dir, file } = seedTranscript(sid);
  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer);
  try {
    const loadInstr = makeInstructionsLoader(dir);
    // Global CLAUDE.md loads BEFORE SessionStart (the real, non-deterministic order).
    await d.routeEvent(loadInstr(sid, '/home/u/.claude/CLAUDE.md', 'GLOBAL', 'session_start'));
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    // Project CLAUDE.md loads AFTER SessionStart.
    await d.routeEvent(loadInstr(sid, '/x/CLAUDE.md', 'PROJECT', 'session_start'));
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await provider.forceFlush();

    const [turn] = turnRoots(exporter.getFinishedSpans());
    assert.ok(turn, 'turn root exported');
    assert.equal(
      turn.attributes[ATTR.SYSTEM_INSTRUCTIONS],
      JSON.stringify([
        { type: 'text', content: 'GLOBAL' },
        { type: 'text', content: 'PROJECT' },
      ]),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('re-loading the same file replaces its content rather than duplicating', async () => {
  const sid = 'sess-dedup';
  const { dir, file } = seedTranscript(sid);
  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer);
  try {
    const loadInstr = makeInstructionsLoader(dir);
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent(loadInstr(sid, '/x/CLAUDE.md', 'V1', 'session_start'));
    // Same path reloads (e.g. after compaction) with new content.
    await d.routeEvent(loadInstr(sid, '/x/CLAUDE.md', 'V2', 'compact'));
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await provider.forceFlush();

    const [turn] = turnRoots(exporter.getFinishedSpans());
    assert.ok(turn, 'turn root exported');
    assert.equal(
      turn.attributes[ATTR.SYSTEM_INSTRUCTIONS],
      JSON.stringify([{ type: 'text', content: 'V2' }]),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stamps system instructions on every turn root (no session span to hang them on)', async () => {
  const sid = 'sess-multiturn';
  const { dir, file } = seedTranscript(sid);
  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer);
  try {
    const loadInstr = makeInstructionsLoader(dir);
    await d.routeEvent(loadInstr(sid, '/x/CLAUDE.md', 'PROJECT', 'session_start'));
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'turn one' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'turn two' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await provider.forceFlush();

    const turns = turnRoots(exporter.getFinishedSpans());
    assert.equal(turns.length, 2, 'both turn roots exported');
    const expected = JSON.stringify([{ type: 'text', content: 'PROJECT' }]);
    for (const turn of turns) {
      assert.equal(turn.attributes[ATTR.SYSTEM_INSTRUCTIONS], expected);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('omits gen_ai.system_instructions when no instructions were loaded', async () => {
  const sid = 'sess-none';
  const { dir, file } = seedTranscript(sid);
  const { tracer, exporter, provider } = setupTracer();
  const d = makeDaemon(tracer);
  try {
    await d.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: file, source: 'startup', cwd: '/x' });
    await d.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'do it' });
    await d.routeEvent({ hook_event_name: 'Stop', session_id: sid });
    await provider.forceFlush();

    const [turn] = turnRoots(exporter.getFinishedSpans());
    assert.ok(turn, 'turn root exported');
    assert.equal(turn.attributes[ATTR.SYSTEM_INSTRUCTIONS], undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

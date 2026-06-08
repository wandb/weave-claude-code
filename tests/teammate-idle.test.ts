// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Tests for the TeammateIdle handler's transcript parsing behaviour.
//
// Teammate transcripts differ from subagent transcripts in two ways:
//   1. They live at <project-dir>/<session-id>.jsonl (not under subagents/)
//   2. The first line is an agent-setting record, not a user message:
//      {"type":"agent-setting","agentSetting":"cks-specialist","sessionId":"..."}
//
// The handler reads agentSetting from line 1, then calls parseSessionFd to
// extract LLM call details. This test suite validates both behaviours using
// real temp files so there are no mocking surprises.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { readFirstTranscriptLine } from '../src/transcriptFile.ts';
import { parseSessionFile } from '../src/parser.ts';
import { startInvokeAgentSpan, emitChatSpansFromAssistantCalls, ATTR } from '../src/genaiSpans.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function setupTracer(): {
  tracer: ReturnType<BasicTracerProvider['getTracer']>;
  exporter: InMemorySpanExporter;
  provider: BasicTracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('test');
  return { tracer, exporter, provider };
}

/** Write a fake teammate transcript to a temp file and return its path.
 *
 * readFirstTranscriptLine requires the path to be within os.homedir() (security
 * check). We use a subdir of the home directory rather than /tmp to satisfy it.
 */
function writeTeammateTranscript(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-test-'));
  const filePath = path.join(dir, 'abc123.jsonl');
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

// ── test data ─────────────────────────────────────────────────────────────────

const AGENT_SETTING_LINE = {
  type: 'agent-setting',
  agentSetting: 'cks-specialist',
  sessionId: 'abc123-session-id',
};

const MODE_LINE = { type: 'mode', mode: 'normal', sessionId: 'abc123-session-id' };

const USER_LINE = {
  parentUuid: null,
  isSidechain: false,
  teamName: 'triage-supp-12345',
  agentName: 'cks-specialist',
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'Investigate the CKS cluster health.' }],
  },
  timestamp: '2026-06-05T10:00:00.000Z',
};

const ASSISTANT_LINE = {
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-4-8',
    id: 'msg_test123',
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 0,
    },
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'The cluster looks healthy. No anomalies detected.' }],
  },
  timestamp: '2026-06-05T10:00:05.000Z',
};

// ── tests ─────────────────────────────────────────────────────────────────────

test('readFirstTranscriptLine: returns agentSetting from teammate transcript', () => {
  const filePath = writeTeammateTranscript([AGENT_SETTING_LINE, MODE_LINE, USER_LINE, ASSISTANT_LINE]);
  try {
    const firstLine = readFirstTranscriptLine(filePath);
    assert.ok(firstLine, 'should read first line');
    assert.equal(firstLine['type'], 'agent-setting');
    assert.equal(firstLine['agentSetting'], 'cks-specialist');
    assert.equal(firstLine['sessionId'], 'abc123-session-id');
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true });
  }
});

test('parseSessionFile: skips agent-setting lines, parses LLM calls from teammate transcript', () => {
  const filePath = writeTeammateTranscript([AGENT_SETTING_LINE, MODE_LINE, USER_LINE, ASSISTANT_LINE]);
  try {
    const parsed = parseSessionFile(filePath);
    assert.ok(parsed, 'parseSessionFile should return non-null');
    assert.equal(parsed.turns.length, 1, 'should produce exactly one turn');

    const turn = parsed.turns[0];
    const calls = turn.assistantCalls();
    assert.equal(calls.length, 1, 'should have one assistant call');

    const call = calls[0];
    assert.equal(call.model, 'claude-opus-4-8');
    assert.equal(call.usage.input_tokens, 1000);
    assert.equal(call.usage.output_tokens, 200);
    assert.equal(call.usage.cache_read_input_tokens, 500);
    assert.equal(call.finishReason, 'end_turn');
    assert.equal(call.responseId, 'msg_test123');

    assert.deepEqual(turn.textBlocks(), ['The cluster looks healthy. No anomalies detected.']);
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true });
  }
});

test('TeammateIdle span tree: invoke_agent span contains chat child', async () => {
  const filePath = writeTeammateTranscript([AGENT_SETTING_LINE, MODE_LINE, USER_LINE, ASSISTANT_LINE]);
  const { tracer, exporter, provider } = setupTracer();

  try {
    const parsed = parseSessionFile(filePath);
    assert.ok(parsed);

    // Mimic what handleTeammateIdle does: agent type comes from payload['teammate_name'],
    // transcript path comes from payload['transcript_path'].
    const agentType = 'cks-specialist'; // from payload['teammate_name']
    const parentSpan = tracer.startSpan('turn');
    const invokeSpan = startInvokeAgentSpan(tracer, parentSpan, {
      agentType,
      conversationId: 'conv-1',
      pluginVersion: '0.2.6',
      displayName: `Agent: ${agentType}`,
    });

    for (const turn of parsed.turns) {
      emitChatSpansFromAssistantCalls(tracer, invokeSpan, 'conv-1', turn.assistantCalls());
    }
    invokeSpan.end();
    parentSpan.end();

    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const invokeAgentSpan = spans.find(s => s.name === 'invoke_agent cks-specialist');
    assert.ok(invokeAgentSpan, 'invoke_agent span should exist');
    assert.equal(
      invokeAgentSpan.attributes[ATTR.AGENT_NAME],
      'cks-specialist',
      'gen_ai.agent.name should be set',
    );

    const chatSpan = spans.find(s => s.name === 'chat claude-opus-4-8');
    assert.ok(chatSpan, 'chat span should exist');

    // Chat span should be a child of the invoke_agent span.
    assert.equal(
      chatSpan.parentSpanContext?.spanId,
      invokeAgentSpan.spanContext().spanId,
      'chat span should be child of invoke_agent span',
    );

    // Token counts should be correct (cache-inclusive total for input).
    assert.equal(chatSpan.attributes[ATTR.USAGE_INPUT_TOKENS], 1500, 'input_tokens = 1000 + 500 cache_read');
    assert.equal(chatSpan.attributes[ATTR.USAGE_OUTPUT_TOKENS], 200);
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true });
  }
});

test('TeammateIdle: multi-turn transcript emits chat spans from all turns', () => {
  const turn2User = {
    ...USER_LINE,
    message: { ...USER_LINE.message, content: [{ type: 'text', text: 'Follow-up question.' }] },
    timestamp: '2026-06-05T10:01:00.000Z',
  };
  const turn2Assistant = {
    ...ASSISTANT_LINE,
    message: {
      ...ASSISTANT_LINE.message,
      id: 'msg_turn2',
      usage: { input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'Follow-up answer.' }],
    },
    timestamp: '2026-06-05T10:01:05.000Z',
  };

  const filePath = writeTeammateTranscript([
    AGENT_SETTING_LINE, MODE_LINE,
    USER_LINE, ASSISTANT_LINE,
    turn2User, turn2Assistant,
  ]);
  try {
    const parsed = parseSessionFile(filePath);
    assert.ok(parsed);
    assert.equal(parsed.turns.length, 2, 'should have 2 turns');

    let totalCalls = 0;
    for (const turn of parsed.turns) {
      totalCalls += turn.assistantCalls().length;
    }
    assert.equal(totalCalls, 2, 'should have 2 assistant calls across both turns');
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true });
  }
});

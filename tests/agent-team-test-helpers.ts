// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { ATTR } from '../src/genaiSpans.ts';
import { TeamCoordinator } from '../src/teamCoordinator.ts';
import {
  assistantEntry,
  childrenOf,
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  makeTranscript,
  spanParentId,
  userEntry,
} from './helpers.ts';

export {
  test,
  assert,
  fs,
  ATTR,
  TeamCoordinator,
  assistantEntry,
  childrenOf,
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  makeTranscript,
  spanParentId,
  userEntry,
};

export const TEAM = 'review-team';
export const MEMBER = 'reviewer';

export function teammateEntries(
  sessionId: string,
  text: string,
  responseId: string,
  agentSetting = MEMBER,
) {
  return [
    { type: 'agent-setting', agentSetting, sessionId },
    {
      type: 'user',
      teamName: TEAM,
      message: { role: 'user', content: `task: ${text}` },
    },
    assistantEntry(responseId, { type: 'text', text }),
  ];
}

export async function coordinator(
  t: TestContext,
  label: string,
  promptId?: string,
) {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = `team-${label}`;
  const transcript = makeTranscript(t, sid, label);
  transcript.append(userEntry('delegate reviews'));
  const daemon = makeGenaiDaemon();
  await daemon.routeEvent({
    hook_event_name: 'SessionStart',
    session_id: sid,
    transcript_path: transcript.file,
    source: 'startup',
    cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: sid,
    transcript_path: transcript.file,
    prompt: 'delegate reviews',
    ...(promptId ? { prompt_id: promptId } : {}),
  });
  return { exporter, daemon, sid, transcript };
}

export async function dispatch(
  daemon: ReturnType<typeof makeGenaiDaemon>,
  sid: string,
  toolUseId: string,
  prompt: string,
  toolInput: Record<string, unknown> = {
    subagent_type: MEMBER,
    prompt,
    team_name: TEAM,
    name: MEMBER,
  },
) {
  await preDispatch(daemon, sid, toolUseId, toolInput);
  await postDispatch(daemon, sid, toolUseId, toolInput);
}

export async function preDispatch(
  daemon: ReturnType<typeof makeGenaiDaemon>,
  sid: string,
  toolUseId: string,
  toolInput: Record<string, unknown>,
) {
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse',
    session_id: sid,
    tool_use_id: toolUseId,
    tool_name: 'Agent',
    tool_input: toolInput,
  });
}

export async function postDispatch(
  daemon: ReturnType<typeof makeGenaiDaemon>,
  sid: string,
  toolUseId: string,
  toolInput: Record<string, unknown>,
) {
  await daemon.routeEvent({
    hook_event_name: 'PostToolUse',
    session_id: sid,
    tool_use_id: toolUseId,
    tool_name: 'Agent',
    tool_input: toolInput,
    tool_response: 'dispatched',
  });
}

export function writeMetadata(transcriptPath: string, agentType = MEMBER) {
  fs.writeFileSync(
    transcriptPath.replace(/\.jsonl$/, '.meta.json'),
    JSON.stringify({ agentType }),
  );
}

export async function startQueueBlocker(
  t: TestContext,
  daemon: ReturnType<typeof makeGenaiDaemon>,
  label: string,
): Promise<{ blocking: Promise<void> }> {
  const sessionId = `${label}-blocker`;
  const transcript = makeTranscript(t, sessionId, sessionId);
  transcript.append(userEntry('block queue'));
  await daemon.routeEvent({
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    transcript_path: transcript.file,
    source: 'startup',
    cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    prompt: 'block queue',
  });
  return {
    blocking: daemon.routeEvent({
      hook_event_name: 'SubagentStart',
      session_id: sessionId,
      agent_id: 'missing-transcript',
      agent_type: 'general-purpose',
    }),
  };
}

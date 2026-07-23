// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import type { TestContext } from 'node:test';
import {
  assistantEntry,
  flushWeave,
  initWeaveInMemory,
  makeGenaiDaemon,
  makeTranscript,
  userEntry,
} from './helpers.ts';

export async function boundAgent(t: TestContext, label: string) {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sid = `sub-${label}`;
  const agentId = `${label}-agent`;
  const transcript = makeTranscript(t, sid, label);
  transcript.append(userEntry('delegate it'));
  const subPath = transcript.subagent(
    agentId,
    userEntry('do it'),
    assistantEntry('sub-msg-1', { type: 'text', text: 'done' }, {
      usage: { input_tokens: 120, output_tokens: 30 },
      finishReason: 'end_turn',
    }),
  );
  const daemon = makeGenaiDaemon();

  await daemon.routeEvent({ hook_event_name: 'SessionStart', session_id: sid, transcript_path: transcript.file, source: 'startup', cwd: '/x' });
  await daemon.routeEvent({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'delegate it' });
  await daemon.routeEvent({
    hook_event_name: 'PreToolUse', session_id: sid, tool_use_id: 'agent-call',
    tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'do it' },
  });
  await daemon.routeEvent({ hook_event_name: 'SubagentStart', session_id: sid, agent_id: agentId, agent_type: 'Explore' });
  return { exporter, daemon, sid, agentId, transcript, subPath };
}

export async function finish(
  daemon: ReturnType<typeof makeGenaiDaemon>,
  sid: string,
) {
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', session_id: sid, reason: 'clear' });
  await flushWeave();
}

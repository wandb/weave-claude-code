// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// `config show` must surface trace_mode (the setting whose whole purpose is to
// be toggled). Legacy settings files lacking the field show the daemon default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, seedConfigHome } from './helpers.ts';

test('config show: legacy settings (no trace_mode) report the daemon default', async () => {
  const { home } = seedConfigHome('trace-mode-default');
  const { stdout } = await runCli(home, ['config', 'show']);
  assert.match(stdout, /trace_mode:\s+daemon \[default\]/);
});

test('config show: trace_mode=session-end is displayed and the socket is flagged unused', async () => {
  const { home } = seedConfigHome('trace-mode-se');
  await runCli(home, ['config', 'set', 'trace_mode', 'session-end']);
  const { stdout } = await runCli(home, ['config', 'show']);
  assert.match(stdout, /trace_mode:\s+session-end \[settings\]/);
  assert.match(stdout, /daemon_socket:.*\(unused in session-end mode\)/);
});

test('config show: WEAVE_TRACE_MODE env override is reflected and labeled', async () => {
  const { home } = seedConfigHome('trace-mode-env');
  const { stdout } = await runCli(home, ['config', 'show'], { WEAVE_TRACE_MODE: 'session-end' });
  assert.match(stdout, /trace_mode:\s+session-end \[WEAVE_TRACE_MODE env var\]/);
});

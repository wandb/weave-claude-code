// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// `config` support for the customizable top-level agent name.
// The seed settings file deliberately OMITS agent_name to mirror an install
// from before the field existed; `get` must still resolve to the default
// rather than error with "Unknown key".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { seedConfigHome, runCli } from './helpers.ts';

test('config agent_name: default, set, get/show, and env-var override', async () => {
  const { home } = seedConfigHome('agentname');
  try {
    // get on a file missing the key resolves to the default, not an error.
    const def = await runCli(home, ['config', 'get', 'agent_name']);
    assert.equal(def.code, 0);
    assert.equal(def.stdout.trim(), 'claude-code');

    // set, then get/show reflect the value (surrounding whitespace is trimmed
    // at resolution time, so the effective value is clean).
    const set = await runCli(home, ['config', 'set', 'agent_name', '  my-team-bot  ']);
    assert.equal(set.code, 0);
    assert.equal((await runCli(home, ['config', 'get', 'agent_name'])).stdout.trim(), 'my-team-bot');
    assert.match((await runCli(home, ['config', 'show'])).stdout, /agent_name:\s+my-team-bot \[settings\.json\]/);

    // WEAVE_AGENT_NAME overrides the settings file.
    const env = { WEAVE_AGENT_NAME: 'from-env' };
    assert.equal((await runCli(home, ['config', 'get', 'agent_name'], env)).stdout.trim(), 'from-env');
    assert.match((await runCli(home, ['config', 'show'], env)).stdout, /agent_name:\s+from-env \[WEAVE_AGENT_NAME env var\]/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

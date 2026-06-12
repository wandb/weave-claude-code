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

test('config agent_name: default, set (trimmed + persisted), and reject empty', async () => {
  const { home, settingsFile } = seedConfigHome('agentname-lifecycle');
  try {
    // get on a file missing the key → default, not an error.
    const def = await runCli(home, ['config', 'get', 'agent_name']);
    assert.equal(def.code, 0);
    assert.match(def.stdout, /claude-code/);

    // set trims surrounding whitespace and persists the trimmed value.
    const set = await runCli(home, ['config', 'set', 'agent_name', '  my-team-bot  ']);
    assert.equal(set.code, 0);
    assert.match(set.stdout, /my-team-bot/);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).agent_name, 'my-team-bot');

    // get reflects the new value.
    const got = await runCli(home, ['config', 'get', 'agent_name']);
    assert.equal(got.stdout.trim(), 'my-team-bot');

    // show lists it with its source.
    const show = await runCli(home, ['config', 'show']);
    assert.match(show.stdout, /agent_name:\s+my-team-bot \[settings\.json\]/);

    // whitespace-only is rejected, leaving the stored value untouched.
    const bad = await runCli(home, ['config', 'set', 'agent_name', '   ']);
    assert.equal(bad.code, 1);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).agent_name, 'my-team-bot');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('config agent_name: WEAVE_AGENT_NAME env var overrides the settings file', async () => {
  const { home } = seedConfigHome('agentname-env');
  try {
    await runCli(home, ['config', 'set', 'agent_name', 'from-file']);

    const got = await runCli(home, ['config', 'get', 'agent_name'], { WEAVE_AGENT_NAME: 'from-env' });
    assert.equal(got.stdout.trim(), 'from-env');

    const show = await runCli(home, ['config', 'show'], { WEAVE_AGENT_NAME: 'from-env' });
    assert.match(show.stdout, /agent_name:\s+from-env \[WEAVE_AGENT_NAME env var\]/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

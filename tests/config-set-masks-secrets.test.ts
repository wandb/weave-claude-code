// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// `config set` must mask wandb_api_key in stdout (it didn't — see #66) but
// must still echo non-sensitive keys in full and persist the full secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { seedConfigHome, runCli } from './helpers.ts';

const SECRET = 'wandb_v1_SUPERSECRETvalueDoNotLeak0123456789';

test('config set: masks wandb_api_key, echoes weave_project in full', async () => {
  const { home, settingsFile } = seedConfigHome('cfgset-mask');
  try {
    const apiKey = await runCli(home, ['config', 'set', 'wandb_api_key', SECRET]);
    assert.equal(apiKey.code, 0);
    assert.equal(apiKey.stdout.includes(SECRET), false, `stdout leaked the secret:\n${apiKey.stdout}`);
    assert.match(apiKey.stdout, /wand…/);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).wandb_api_key, SECRET);

    const project = await runCli(home, ['config', 'set', 'weave_project', 'my-entity/my-project']);
    assert.equal(project.code, 0);
    assert.match(project.stdout, /my-entity\/my-project/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

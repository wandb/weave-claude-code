// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Regression: a daemon must only unlink the socket file it actually bound.
//
// The bug: on `restart`, the old daemon's drain() closed its server early but
// unlinked the socket LATE — after the (potentially slow) provider.shutdown()
// flush. A daemon spawned during that window bound the path, and the old
// daemon's late unlink then deleted the NEW daemon's live socket ~a second
// later, orphaning it (listening on a dangling inode) so the next hook cold-
// started yet another daemon: duplicate, flapping daemons.
//
// The fix records the inode of the socket this daemon bound and only releases a
// socket file it still owns (`releaseOwnedSocket`), and drain() releases it
// up-front rather than after the flush. These tests pin the ownership check.
//
// Sockets live under /tmp for the macOS 104-char UNIX socket path cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { GlobalDaemon } from '../src/daemon.ts';

// Private methods/fields we drive directly. No project/key → tracing disabled,
// isolating the socket lifecycle from OTel.
type DaemonInternals = {
  bindSocketWithHerdProtection(): Promise<void>;
  releaseOwnedSocket(): void;
  server?: net.Server;
};

function makeDaemon(sock: string, dir: string): DaemonInternals {
  return new GlobalDaemon(sock, path.join(dir, 'd.log'), null, null, 'https://x', false, 'claude-code') as unknown as DaemonInternals;
}

test('releaseOwnedSocket unlinks the socket this daemon bound', async () => {
  const dir = fs.mkdtempSync('/tmp/wcp-own-');
  const sock = path.join(dir, 'daemon.sock');
  const d = makeDaemon(sock, dir);
  try {
    await d.bindSocketWithHerdProtection();
    assert.ok(fs.existsSync(sock), 'daemon bound its socket');
    d.releaseOwnedSocket();
    assert.ok(!fs.existsSync(sock), 'releaseOwnedSocket removes the socket it owns');
  } finally {
    try { d.server?.close(); } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseOwnedSocket leaves a socket a successor rebound (different inode)', async () => {
  const dir = fs.mkdtempSync('/tmp/wcp-own-');
  const sock = path.join(dir, 'daemon.sock');
  const d = makeDaemon(sock, dir);
  const successor = net.createServer();
  try {
    await d.bindSocketWithHerdProtection(); // records the owned inode

    // A successor reclaims the path with a fresh socket (new inode), exactly as a
    // restart-spawned daemon does while the old daemon is still draining.
    fs.unlinkSync(sock);
    await new Promise<void>((r) => successor.listen(sock, () => r()));
    const successorInode = fs.statSync(sock).ino;

    // The old daemon releasing its socket must NOT delete the successor's.
    d.releaseOwnedSocket();

    assert.ok(fs.existsSync(sock), 'successor socket must survive the old daemon releasing');
    assert.equal(fs.statSync(sock).ino, successorInode, "the socket is still the successor's");
  } finally {
    try { successor.close(); } catch { /* best effort */ }
    try { d.server?.close(); } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

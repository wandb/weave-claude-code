// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-plugin

// Helper for probeUnixSocket "stale" test. Binds the socket path passed in
// argv[2] and stays alive until the parent SIGKILLs it. Intentionally does NOT
// register a shutdown handler — the test relies on the socket file surviving
// the kill, which is the production failure mode.

import * as net from 'node:net';

const socketPath = process.argv[2];
if (!socketPath) {
  console.error('usage: bind-socket-child.mjs <path>');
  process.exit(1);
}

const server = net.createServer();
server.listen(socketPath, () => {
  process.send?.('listening');
});

// Keep the event loop alive indefinitely.
setInterval(() => {}, 1 << 30);

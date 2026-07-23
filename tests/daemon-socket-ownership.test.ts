// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { GlobalDaemon } from '../src/daemon.ts';

type DaemonInternals = {
  bindSocketWithHerdProtection(): Promise<void>;
  releaseOwnedSocket(): void;
  drain(reason: string): Promise<void>;
  traceRuntime: {
    waitForPendingEvents(): Promise<void>;
  };
  ownedSocketInode?: number;
  server?: net.Server;
};

function makeDaemon(socketPath: string, dir: string): DaemonInternals {
  return new GlobalDaemon(socketPath, path.join(dir, 'daemon.log'), {
    weaveProject: null,
    apiKey: null,
    baseUrl: 'https://x',
    agentName: 'claude-code',
    debug: false,
  }) as unknown as DaemonInternals;
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise(resolve => server.listen(socketPath, resolve));
}

test('socket release never unlinks a successor inode', async (t) => {
  const dir = fs.mkdtempSync('/tmp/wcp-socket-owner-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = makeDaemon(socketPath, dir);
  const successor = net.createServer();
  t.after(() => { try { successor.close(); } catch { /* already closed */ } });
  t.after(() => { try { daemon.server?.close(); } catch { /* already closed */ } });

  await daemon.bindSocketWithHerdProtection();
  fs.unlinkSync(socketPath);
  await listen(successor, socketPath);
  const successorInode = fs.statSync(socketPath).ino;

  daemon.releaseOwnedSocket();

  assert.equal(fs.statSync(socketPath).ino, successorInode);
});

test('early release captures ownership from its listening server', async (t) => {
  const dir = fs.mkdtempSync('/tmp/wcp-socket-early-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = makeDaemon(socketPath, dir);
  t.after(() => { try { daemon.server?.close(); } catch { /* already closed */ } });

  await daemon.bindSocketWithHerdProtection();
  daemon.ownedSocketInode = undefined;
  daemon.releaseOwnedSocket();

  assert.equal(fs.existsSync(socketPath), false);
});

test('drain releases socket ownership before waiting for queued hooks', async (t) => {
  const dir = fs.mkdtempSync('/tmp/wcp-socket-drain-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = makeDaemon(socketPath, dir);
  let releaseQueue!: () => void;
  const queue = new Promise<void>(resolve => { releaseQueue = resolve; });
  daemon.traceRuntime.waitForPendingEvents = () => queue;

  await daemon.bindSocketWithHerdProtection();
  const draining = daemon.drain('test');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(socketPath), false);

  const successor = net.createServer();
  t.after(() => { try { successor.close(); } catch { /* already closed */ } });
  await listen(successor, socketPath);
  const successorInode = fs.statSync(socketPath).ino;
  releaseQueue();
  await draining;

  assert.equal(fs.statSync(socketPath).ino, successorInode);
});

test('drain never removes a successor while old connections close', async (t) => {
  const dir = fs.mkdtempSync('/tmp/wcp-socket-handoff-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = makeDaemon(socketPath, dir);

  await daemon.bindSocketWithHerdProtection();
  const oldClient = net.createConnection(socketPath);
  t.after(() => oldClient.destroy());
  await new Promise<void>((resolve, reject) => {
    oldClient.once('connect', resolve);
    oldClient.once('error', reject);
  });

  const draining = daemon.drain('test');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(socketPath), false);

  const successor = net.createServer();
  t.after(() => { try { successor.close(); } catch { /* already closed */ } });
  await listen(successor, socketPath);
  const successorInode = fs.statSync(socketPath).ino;

  oldClient.end();
  await draining;
  assert.equal(fs.statSync(socketPath).ino, successorInode);
});

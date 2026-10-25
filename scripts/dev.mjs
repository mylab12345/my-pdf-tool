#!/usr/bin/env node
/**
 * Development runner: builds main/preload (watch mode), starts the Vite dev
 * server for the renderer and launches Electron against it.
 *
 * Only used for local development; CI never runs this script.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 5199;

function waitForPort(port, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createServer()
        .once('error', () => setTimeout(attempt, 250))
        .once('listening', () => socket.close(() => resolve()))
        .listen(port, '127.0.0.1');
      if (Date.now() - started > timeoutMs) reject(new Error('vite dev server did not start'));
    };
    attempt();
  });
}

const children = [];
function run(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  children.push(child);
  return child;
}

const shutdown = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run(process.execPath, [path.join(root, 'scripts/build-main.mjs'), '--watch']);
run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort']);
await waitForPort(PORT);
const electronBin = process.platform === 'win32'
  ? path.join(root, 'node_modules/electron/dist/electron.exe')
  : path.join(root, 'node_modules/electron/dist/electron');
run(electronBin, [root], { ELECTRON_RENDERER_URL: `http://localhost:${PORT}`, NODE_ENV: 'development' });

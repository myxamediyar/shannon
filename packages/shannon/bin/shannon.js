#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');

const port = process.env.PORT || process.env.SHANNON_PORT || '1948';
const host = process.env.HOST || process.env.SHANNON_HOST || '127.0.0.1';
const url = `http://localhost:${port}`;
const projectDir = path.resolve(__dirname, '..');

let nextBin;
try {
  nextBin = require.resolve('next/dist/bin/next', { paths: [projectDir] });
} catch {
  console.error('shannon: could not locate Next.js. Reinstall with `npm i -g tryshannon`.');
  process.exit(1);
}

if (process.env.SHANNON_NO_OPEN !== '1') {
  setTimeout(() => {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  }, 2000);
}

const child = spawn(process.execPath, [nextBin, 'start', '-H', host, '-p', String(port)], {
  cwd: projectDir,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

'use strict';
// One xray instance per pool exit, each on its own loopback port. A single rotating
// port was tried first: xray's balancer needs observatory health data and silently
// fell through to `direct`, so separate processes are used instead.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const C = require('./config');

const BASE = 18100;
const running = new Map(); // tag -> { proc, port }

function start(exit, index) {
  const port = BASE + index;
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{ listen: '127.0.0.1', port, protocol: 'http', tag: 'in' }],
    outbounds: [exit],
  };
  const file = path.join(C.RUNTIME, 'cache', `exit-${index}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  const proc = spawn(C.xrayExe, ['run', '-c', file], { windowsHide: true, stdio: 'ignore' });
  proc.on('exit', () => running.delete(exit.tag));
  running.set(exit.tag, { proc, port });
  return port;
}

function startAll(pool) {
  stopAll();
  pool.forEach((exit, i) => start(exit, i));
}

function stopAll() {
  for (const { proc } of running.values()) {
    try { proc.kill(); } catch { /* gone */ }
  }
  running.clear();
}

function portFor(tag) {
  return running.get(tag)?.port;
}

function live() {
  return [...running.entries()].map(([tag, v]) => ({ tag, port: v.port }));
}

module.exports = { startAll, stopAll, portFor, live };

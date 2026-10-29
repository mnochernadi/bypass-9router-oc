'use strict';
// Paths and settings. The bypass owns only runtime/; nothing outside this folder is
// touched except 9router's own API, which is called as a client.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname.replace(/lib$/, '').replace(/[\\/]$/, '');
const RUNTIME = path.join(ROOT, 'runtime');
const BIN = path.join(ROOT, 'bin');
const PUBLIC = path.join(ROOT, 'public');
const SETTINGS_FILE = path.join(RUNTIME, 'settings.json');

const DEFAULTS = {
  port: 8791,
  proxyPort: 18090,
  upstream: 'http://127.0.0.1:20128/v1',
  upstreamKey: '',
  model: 'ope/opencode-free/deepseek-v4.1-flash-free',
  poolTarget: 12,
  poolTtlHours: 12,
  probeConcurrency: 8,
  requestTimeoutSec: 900,
  apiKey: '',
  subs: [
    'https://raw.githubusercontent.com/papa8274/sub-mirror/main/subscription.txt',
    'https://raw.githubusercontent.com/papa8274/sub-mirror/main/subscription1000.txt',
  ],
};

function ensureDirs() {
  for (const d of [RUNTIME, BIN, path.join(RUNTIME, 'cache'), path.join(RUNTIME, 'subs')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function settings() {
  ensureDirs();
  let merged;
  try {
    merged = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    merged = { ...DEFAULTS };
  }
  let dirty = false;
  if (!merged.apiKey) {
    merged.apiKey = `sk-b9-${crypto.randomBytes(24).toString('hex')}`;
    dirty = true;
  }
  if (dirty) fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = {
  ROOT, RUNTIME, BIN, PUBLIC, DEFAULTS, ensureDirs, settings, saveSettings,
  poolFile: path.join(RUNTIME, 'pool.json'),
  badFile: path.join(RUNTIME, 'bad.json'),
  metaFile: path.join(RUNTIME, 'pool.meta'),
  xrayCfg: path.join(RUNTIME, 'xray.json'),
  xrayExe: path.join(BIN, 'xray.exe'),
  logFile: path.join(RUNTIME, 'bypass.log'),
};

'use strict';
// One-time setup: fetch xray, build the exit pool.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const C = require('./config');

const URL = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip';

async function main() {
  C.ensureDirs();
  const s = C.settings();
  if (!fs.existsSync(C.xrayExe)) {
    console.log('downloading xray...');
    const r = await fetch(URL, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
    const zip = path.join(C.BIN, 'xray.zip');
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${C.BIN}' -Force`], { stdio: 'inherit' });
    fs.unlinkSync(zip);
  }
  console.log(execFileSync(C.xrayExe, ['-version'], { encoding: 'utf8' }).split('\n')[0].trim());

  const pool = require('./pool');
  const exits = await pool.refresh(s, (m) => console.log(`  ${m}`));
  console.log(`\nready: ${pool.readPool().length} exits. start with: node server.js`);
  return exits;
}

main().catch((e) => { console.error(`setup failed: ${e.message}`); process.exit(1); });

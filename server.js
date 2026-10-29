'use strict';
// bypass-9router-oc -- keeps 9router's OpenCode Free answering by changing the egress
// IP in front of it. Zero dependencies.
//
//   harness -> this -> rotating v2ray exit -> 9router (127.0.0.1:20128) -> opencode
//
// On a free-usage limit the exit that was refused is parked and the call is retried
// from the next one. The pool is rebuilt from the subscriptions on a timer and when
// it runs dry.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const C = require('./lib/config');
const pool = require('./lib/pool');
const exits = require('./lib/exits');
const proxy = require('./lib/proxy');
const tunnel = require('./lib/tunnel');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const clients = new Set();
let busy = false;
let lastRun = null;
let proxyServer = null;

function broadcast(ev) {
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch { clients.delete(res); } }
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFileSync(C.logFile, line);
  broadcast({ type: 'log', message });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function body(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

async function loadPool(s, onLog) {
  const p = await pool.ensurePool(s, onLog);
  exits.startAll(p);
  return p;
}

function state() {
  const s = C.settings();
  const bad = pool.readBad();
  return {
    pool: pool.readPool().map((e) => ({
      tag: e.tag,
      address: e.settings.vnext[0].address,
      port: e.settings.vnext[0].port,
      parked: bad.has(e.tag),
      up: Boolean(exits.portFor(e.tag)),
    })),
    ageHours: pool.poolAgeHours(),
    busy,
    lastRun,
    endpoint: `http://127.0.0.1:${s.port}/v1`,
    apiKey: s.apiKey,
    settings: {
      upstream: s.upstream, model: s.model, proxyPort: s.proxyPort,
      poolTarget: s.poolTarget, poolTtlHours: s.poolTtlHours, subs: s.subs,
    },
  };
}

function pickLive() {
  const bad = pool.readBad();
  return pool.readPool().filter((e) => !bad.has(e.tag) && exits.portFor(e.tag));
}

const LIMIT = /Free usage limit|FreeUsageLimit|rate.?limit|"status":\s*429|\b429\b/i;

async function forward(s, payload, onEvent) {
  let attempts = 0;
  for (;;) {
    const live = pickLive();
    if (!live.length) {
      log('every exit is parked -- refreshing');
      const fresh = await pool.refresh(s, log);
      if (!fresh.length) return { ok: false, status: 502, text: 'no working exit', attempts };
      exits.startAll(fresh);
      continue;
    }
    const exit = live[0];
    const v = exit.settings.vnext[0];
    const where = `${v.address}:${v.port}`;
    const port = exits.portFor(exit.tag);
    attempts++;

    let res;
    try {
      res = await tunnel.request(port, `${s.upstream}/chat/completions`, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${s.upstreamKey}`,
          accept: payload.stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(payload),
        timeoutMs: s.requestTimeoutSec * 1000,
      });
    } catch (e) {
      pool.park(exit.tag);
      log(`error on ${where}: ${e.message}`);
      if (attempts > 20) return { ok: false, status: 502, text: e.message, attempts };
      continue;
    }

    if (res.status === 429) {
      pool.park(exit.tag);
      log(`limit on ${where} -> next exit`);
      res.stream.resume();
      continue;
    }
    if (res.status >= 400) {
      let text = '';
      for await (const chunk of res.stream) text += chunk;
      if (LIMIT.test(text)) {
        pool.park(exit.tag);
        log(`limit on ${where} -> next exit`);
        continue;
      }
      return { ok: false, status: res.status, text, attempts, exit: where };
    }
    log(`exit ${where} (attempt ${attempts})`);
    return { ok: true, status: res.status, stream: res.stream, headers: res.headers, attempts, exit: where };
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/state') return json(res, 200, state());

  if (p.startsWith('/v1/') || p === '/chat/completions') {
    const key = C.settings().apiKey;
    const sent = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (key && sent !== key) return json(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });
  }

  if (p === '/v1/models') {
    const s = C.settings();
    try {
      const r = await tunnel.request(s.proxyPort, `${s.upstream}/models`, {
        method: 'GET', headers: { authorization: `Bearer ${s.upstreamKey}` }, timeoutMs: 30000,
      });
      let text = '';
      for await (const c of r.stream) text += c;
      res.writeHead(r.status, { 'content-type': 'application/json' });
      return res.end(text);
    } catch (e) {
      return json(res, 502, { error: { message: e.message } });
    }
  }

  if ((p === '/v1/chat/completions' || p === '/chat/completions') && req.method === 'POST') {
    if (busy) return json(res, 429, { error: { message: 'a request is already in flight', type: 'rate_limit_error' } });
    const payload = await body(req);
    const s = C.settings();
    if (!payload.model) payload.model = s.model;
    busy = true;
    broadcast({ type: 'state' });
    log(`request: ${payload.model}`);

    try {
      const r = await forward(s, payload, (m) => log(m));
      if (!r.ok) {
        lastRun = { ok: false, text: r.text.slice(0, 400), exit: r.exit, attempts: r.attempts, at: Date.now() };
        broadcast({ type: 'done', ...lastRun });
        return json(res, r.status, { error: { message: r.text, type: 'upstream_error' } });
      }
      lastRun = { ok: true, text: '', exit: r.exit, attempts: r.attempts, at: Date.now() };
      broadcast({ type: 'done', ...lastRun });
      res.writeHead(200, {
        'content-type': r.headers['content-type'] || 'application/json',
        'cache-control': 'no-store',
        'x-bypass-exit': r.exit,
        'x-bypass-attempts': String(r.attempts),
      });
      r.stream.pipe(res);
    } catch (e) {
      return json(res, 502, { error: { message: e.message } });
    } finally {
      busy = false;
      broadcast({ type: 'state' });
    }
    return;
  }

  if (p === '/api/refresh' && req.method === 'POST') {
    if (busy) return json(res, 409, { error: 'a request is in flight' });
    pool.refresh(C.settings(), log)
      .then((p2) => { exits.startAll(p2); log(`pool: ${p2.length} exits`); broadcast({ type: 'state' }); })
      .catch((e) => log(`refresh failed: ${e.message}`));
    return json(res, 202, { started: true });
  }

  if (p === '/api/park' && req.method === 'POST') {
    const { tag, parked } = await body(req);
    if (parked) pool.park(tag); else pool.unpark(tag);
    broadcast({ type: 'state' });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const patch = await body(req);
    if (typeof patch.subs === 'string') patch.subs = patch.subs.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (Array.isArray(patch.subs) && !patch.subs.length) delete patch.subs;
    for (const k of ['poolTarget', 'poolTtlHours', 'proxyPort']) if (patch[k] !== undefined) patch[k] = Number(patch[k]);
    C.saveSettings(patch);
    broadcast({ type: 'state' });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/log') {
    let tail = '';
    try { tail = fs.readFileSync(C.logFile, 'utf8').split('\n').slice(-200).join('\n'); } catch { /* none */ }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(tail);
  }

  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.join(C.PUBLIC, rel);
  if (file.startsWith(C.PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404); res.end('not found');
}

async function main() {
  C.ensureDirs();
  const s = C.settings();
  const p = await loadPool(s, log);
  log(`pool: ${p.length} exits`);
  proxyServer = proxy.start(s.proxyPort, log);
  http.createServer((req, res) => { handle(req, res).catch((e) => json(res, 500, { error: e.message })); })
    .listen(s.port, '127.0.0.1', () => {
      console.log(`bypass dashboard: http://127.0.0.1:${s.port}`);
      console.log(`point 9router's proxy pool at 127.0.0.1:${s.proxyPort}`);
    });
}

process.on('uncaughtException', (e) => { log(`uncaught: ${e.stack || e.message}`); });
process.on('unhandledRejection', (e) => { log(`rejected: ${e && e.message || e}`); });
process.on('SIGINT', () => { exits.stopAll(); proxyServer?.close(); process.exit(0); });
main();

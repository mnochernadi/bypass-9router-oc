'use strict';
// A loopback HTTP proxy that rotates the exit on every connection. 9router can be
// pointed at this as its proxy pool, and the bypass's own upstream calls go through
// it too, so the egress IP changes per request.

const http = require('node:http');
const net = require('node:net');
const exits = require('./exits');

let cursor = 0;

function nextPort() {
  const live = exits.live();
  if (!live.length) return null;
  const pick = live[cursor % live.length];
  cursor++;
  return pick.port;
}

function pipe(a, b) {
  a.pipe(b);
  b.pipe(a);
  a.on('error', () => b.destroy());
  b.on('error', () => a.destroy());
}

function start(port, onLog = () => {}) {
  const server = http.createServer((req, res) => {
    onLog(`req ${req.method} ${req.url}`);
    try {
    // Plain HTTP through the proxy: absolute-form URL.
    const target = new URL(req.url);
    const hop = nextPort();
    if (!hop) { res.writeHead(502); return res.end('no exit'); }
    const up = http.request({
      host: '127.0.0.1', port: hop, method: req.method,
      path: target.href, headers: req.headers,
    }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', (e) => { onLog(`exit failed: ${e.message}`); try { res.writeHead(502); res.end('exit failed'); } catch { /* gone */ } });
    req.pipe(up);
    } catch (e) { onLog(`proxy error: ${e.message}`); try { res.writeHead(502); res.end(); } catch { /* gone */ } }
  });

  server.on('connect', (req, socket, head) => {
    const hop = nextPort();
    if (!hop) { socket.end('HTTP/1.1 502 No Exit\r\n\r\n'); return; }

    // The exit is itself an HTTP proxy, so it needs its own CONNECT before any bytes
    // are relayed. Only after it answers 200 does the client get its 200.
    const up = net.connect(hop, '127.0.0.1');
    let established = false;
    let buf = '';

    up.on('connect', () => {
      up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`);
    });

    up.on('data', (d) => {
      if (established) { socket.write(d); return; }
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const status = buf.slice(0, buf.indexOf('\r\n'));
      if (!/ 200 /.test(status)) {
        onLog(`exit refused: ${status}`);
        socket.end(`HTTP/1.1 502 Exit Refused\r\n\r\n`);
        up.destroy();
        return;
      }
      established = true;
      const rest = Buffer.from(buf.slice(end + 4), 'latin1');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      if (rest.length) socket.write(rest);
      socket.on('data', (c) => up.write(c));
      socket.resume();
    });

    up.on('error', (e) => { onLog(`exit error: ${e.message}`); socket.destroy(); });
    up.on('close', () => socket.destroy());
    socket.on('error', () => up.destroy());
    socket.on('close', () => up.destroy());
  });

  server.listen(port, '127.0.0.1', () => onLog(`rotating proxy on 127.0.0.1:${port}`));
  return server;
}

module.exports = { start };

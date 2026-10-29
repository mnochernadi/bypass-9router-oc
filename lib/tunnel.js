'use strict';
// Send a request through the rotating proxy.
//
// Plain-HTTP upstreams use the proxy's absolute-form path (what curl does with -x):
// the proxy picks the exit and forwards. HTTPS upstreams get a CONNECT tunnel first.

const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');

function tunnel(proxyPort, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error('proxy connect timeout')); });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      sock.removeListener('data', onData);
      sock.setTimeout(0);
      const status = buf.slice(0, buf.indexOf('\r\n'));
      if (!/ 200 /.test(status)) { sock.destroy(); reject(new Error(`proxy refused: ${status}`)); return; }
      const secure = tls.connect({ socket: sock, servername: host }, () => resolve(secure));
      secure.on('error', reject);
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

async function request(proxyPort, url, { method = 'POST', headers = {}, body, timeoutMs = 900000 } = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || (secure ? 443 : 80);

  const send = (opts) => new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res }));
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

  if (!secure) {
    // Absolute-form straight at the proxy: it chooses the exit and relays.
    return send({
      host: '127.0.0.1',
      port: proxyPort,
      method,
      path: u.href,
      headers: { host: u.host, ...headers },
      timeout: timeoutMs,
    });
  }

  const sock = await tunnel(proxyPort, u.hostname, port, 30000);
  return send({
    method,
    path: u.pathname + u.search,
    headers: { host: u.host, ...headers },
    createConnection: () => sock,
    timeout: timeoutMs,
  });
}

module.exports = { request };

'use strict';

const $ = (id) => document.getElementById(id);
const out = $('out');
const logEl = $('log');

function append(el, text, cls) {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  el.appendChild(s);
  el.scrollTop = el.scrollHeight;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText);
  return r.json().catch(() => ({}));
}

function render(s) {
  $('poolinfo').textContent = `${s.pool.length} exits`;
  $('poolinfo').className = 'badge ' + (s.pool.length ? 'ok' : 'warn');
  $('run').disabled = s.busy;
  $('refresh').disabled = s.busy;

  const tb = $('pool');
  tb.textContent = '';
  for (const e of s.pool) {
    const tr = document.createElement('tr');
    if (e.parked) tr.className = 'parked';
    tr.innerHTML = `<td><span class="dot ${e.parked ? 'parked' : e.up ? 'ok' : 'down'}"></span></td>` +
      `<td>${e.address}:${e.port}</td><td>${e.parked ? 'parked' : e.up ? 'up' : 'down'}</td><td></td>`;
    const b = document.createElement('button');
    b.textContent = e.parked ? 'unpark' : 'park';
    b.onclick = () => api('/api/park', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: e.tag, parked: !e.parked }),
    });
    tr.lastChild.appendChild(b);
    tb.appendChild(tr);
  }

  $('endpoint').value = s.endpoint;
  $('apikey').value = s.apiKey;
  if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    $('upstream').value = s.settings.upstream;
    $('model').value = s.settings.model;
    $('proxyPort').value = s.settings.proxyPort;
    $('subs').value = s.settings.subs.join('\n');
  }
}

async function refreshState() {
  try { render(await api('/api/state')); } catch { /* restarting */ }
}

$('run').onclick = async () => {
  const prompt = $('prompt').value.trim() || 'say OK';
  out.textContent = '';
  append(out, `> ${prompt}\n`, 'warn');
  try {
    const r = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${$('apikey').value}` },
      body: JSON.stringify({ model: $('model').value.trim(), messages: [{ role: 'user', content: prompt }] }),
    });
    const text = await r.text();
    if (!r.ok) { append(out, text + '\n', 'bad'); return; }
    try {
      const j = JSON.parse(text);
      append(out, (j.choices?.[0]?.message?.content || text) + '\n', 'ok');
    } catch { append(out, text + '\n'); }
    append(out, `exit ${r.headers.get('x-bypass-exit')} (attempt ${r.headers.get('x-bypass-attempts')})\n`, 'ok');
  } catch (e) { append(out, `${e.message}\n`, 'bad'); }
};

$('refresh').onclick = async () => {
  out.textContent = '';
  append(out, 'rebuilding pool...\n', 'warn');
  try { await api('/api/refresh', { method: 'POST' }); } catch (e) { append(out, `${e.message}\n`, 'bad'); }
};

$('save').onclick = async () => {
  try {
    await api('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upstream: $('upstream').value.trim(), model: $('model').value.trim(),
        proxyPort: $('proxyPort').value, subs: $('subs').value,
      }),
    });
    append(out, 'saved\n', 'ok');
  } catch (e) { append(out, `${e.message}\n`, 'bad'); }
};

const copy = (id) => navigator.clipboard.writeText($(id).value).then(() => append(out, 'copied\n', 'ok'));
$('copyEndpoint').onclick = () => copy('endpoint');
$('copyKey').onclick = () => copy('apikey');

const es = new EventSource('/api/stream');
es.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === 'log') append(logEl, `${m.message}\n`);
  else if (m.type === 'done') append(out, `\n${m.ok ? 'ok' : 'failed'} via ${m.exit} (attempt ${m.attempts})\n`, m.ok ? 'ok' : 'bad');
  else if (m.type === 'state') refreshState();
};

fetch('/api/log').then((r) => r.text()).then((t) => { logEl.textContent = t; logEl.scrollTop = logEl.scrollHeight; });
refreshState();
setInterval(refreshState, 5000);

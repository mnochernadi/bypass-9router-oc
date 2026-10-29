# bypass-9router-oc

Keeps 9router's **OpenCode Free** answering by changing the egress IP in front of it.

```
harness ──▶ this ──▶ rotating v2ray exit ──▶ 9router (127.0.0.1:20128) ──▶ opencode
```

The free allowance is refused per IP, so the answer to a spent IP is another IP. This
sits in front of 9router, keeps a pool of exits built from a subscription, and on a
limit parks the exit that was refused and retries from the next one.

Not a router: no model mapping, no fallbacks, no provider logic. It forwards what it
is given to 9router and relays the answer.

```powershell
npm run setup     # once: fetch xray, build the pool
npm start         # dashboard on http://127.0.0.1:8791
```

## Two ways to use it

**1. Point a harness here.** Set the base URL to `http://127.0.0.1:8791/v1` and the key
from the dashboard. Requests are forwarded to 9router through a rotating exit.

```bash
KEY=$(node -p "require('./runtime/settings.json').apiKey")
curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:8791/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"oc/deepseek-v4.1-flash-free","messages":[{"role":"user","content":"say OK"}]}'
```

**2. Point 9router's proxy pool here.** The dashboard also runs a plain rotating HTTP
proxy on `127.0.0.1:18090` (every connection takes the next exit). Register that in
9router's proxy pool and 9router's own upstream calls rotate, with no client change.

## Behaviour

| Upstream says | What happens |
|---|---|
| free-usage limit (`429`, or a `5xx` carrying `FreeUsageLimitError`) | exit parked, retried from the next one |
| transport failure / timeout | exit parked, retried |
| anything else | relayed as-is |

The pool is rebuilt from the subscriptions every 12 h and immediately when every exit
is parked. Exits are probed before they enter the pool.

## Isolation

Nothing system-wide is touched. The bypass owns only `runtime/`; it calls 9router as a
client and never edits 9router's config or database.

## Layout

```
server.js        dashboard + OpenAI passthrough (node:http, zero dependencies)
lib/pool.js      subscription fetch, URI parse, probe, refresh
lib/exits.js     one xray per exit on its own loopback port
lib/proxy.js     rotating HTTP proxy for 9router's proxy pool
lib/tunnel.js    request through the proxy
lib/config.js    paths, settings
public/          dashboard
runtime/         pool, settings, logs (gitignored)
bin/             xray.exe (gitignored, fetched by setup)
```

## Notes

- Subscription URIs are malformed upstream: the `path` parameter swallows the
  following keys (`path=/fp=chrome&security=tls`). `parse()` splits the real path out
  and keeps the WebSocket `Host` header separate from the TLS SNI.
- The per-request xray config carries only the chosen outbound, no `direct` fallback,
  so a dead exit fails loudly instead of silently answering from the local IP.
- One request in flight at a time; a second gets `429`.

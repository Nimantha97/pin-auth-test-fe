# evina-pin-test-fe

A small, **standalone** frontend + server-side proxy to live-test the EVINA
anti-fraud flow against the real pin-auth **v2** `subscribe` / `submitPin`
endpoints. No dependency on the main SDK monorepo — DevOps can point a
deployment root straight at this folder and run `npm install && npm start`.

```
Browser (your DNS) ──> this app (proxy) ──> pin-auth v2 (Java) ──> EVINA sidecar ──> EVINA
```

The browser only ever talks to this app (same origin — no CORS). The app adds
the `X-JWT-Assertion` header **server-side** (so the app credential never
reaches the browser), forwards to pin-auth, and returns pin-auth's response
verbatim — including `data.evinaScript`, which the page injects so the EVINA
kit watches the submit button.

---

## Why this and not the static Cloudflare page?

Calling pin-auth directly from a browser fails on CORS and leaks the app
credential into client code. A server-side proxy avoids both: same-origin
requests from the page, secret header added on the server.

---

## What it talks to

| Route (this app) | Forwards to pin-auth | Body sent |
|---|---|---|
| `POST /api/subscribe` | `POST {PIN_AUTH_BASE}{SUBSCRIBE_PATH}` | `{ msisdn, serviceId?, vendorRef, client{ type, ip, userAgent, url } }` |
| `POST /api/submitPin` | `POST {PIN_AUTH_BASE}{SUBMIT_PATH}` | `{ pin, serverRef, vendorRef }` |

Both carry the `X-JWT-Assertion` header (built from your app id).

Confirmed target:
`https://idm-op-app-01.ideabiz.lk/ib-int/pin-api/v1/pin/subscription/v2/subscribe`

---

## Authentication (important)

The pin-auth v2 controller declares `@RequestHeader("X-JWT-Assertion")` and
reads only the `applicationid` claim from the token — it does **not** verify the
signature. So this app builds the exact same unsigned WSO2-style token pin-auth
itself produces in `JWT.getJWTforApp(appId)`. **You only supply the app id.**

> The OAuth `Authorization: Bearer <token>` you may have is for the *public*
> `ideabiz.lk/apicall/...` gateway — a different door. For the internal v2
> endpoints use `X-JWT-Assertion` (the default here). `AUTH_MODE=bearer` is kept
> as a fallback if you ever point this at the public gateway.

---

## Configure

```powershell
copy .env.example .env
# then edit .env
```

Normally you only set two things:

```
PIN_AUTH_APP_ID=<a SUBSCRIPTION app id that exists in pin-auth's DB>
# PIN_AUTH_BASE is already the confirmed internal v2 host/prefix.
```

Full reference lives in `.env.example`. Key fields:

| Var | Meaning |
|---|---|
| `PIN_AUTH_BASE` | pin-auth host + path prefix (no trailing slash) |
| `SUBSCRIBE_PATH` / `SUBMIT_PATH` | endpoint paths appended to base |
| `AUTH_MODE` | `jwt-assertion` (default) or `bearer` |
| `PIN_AUTH_APP_ID` | app id used to build `X-JWT-Assertion` |
| `PIN_AUTH_JWT` | paste a full token to use verbatim (optional) |
| `BEARER_TOKEN` | OAuth token (only when `AUTH_MODE=bearer`) |
| `PIN_AUTH_SERVICE_ID` | optional serviceId; empty = app default |
| `LANGUAGE` | SMS template language `sin`/`tam`/empty |
| `TARGET_SELECTOR` | CSS selector the EVINA kit watches (`#submit-pin`) |
| `INSECURE_TLS` | `1` to skip TLS verification (internal certs only) |
| `PORT` | port this app listens on (binds `0.0.0.0`) |
| `LOG_LEVEL` | `debug` while troubleshooting |

---

## Run locally

```powershell
npm install
npm start
```

Open <http://localhost:4100>. Dev with reload: `npm run dev`.

## Build + run for deployment

```powershell
npm install
npm run build      # compiles to dist/ and copies the frontend
npm run serve      # node dist/server.js
```

The app binds `0.0.0.0:PORT`, so once DevOps maps your DNS to this host:port,
testers reach the page at `http://<your-dns>/`.

> `npm start` (via `tsx`) also works in production if you prefer not to compile.

---

## Using it

1. Enter an MSISDN → **Request PIN**. The proxy calls pin-auth `subscribe`;
   pin-auth sends the SMS and returns `serverRef` + `evinaScript`. The page
   injects the kit (status line turns green).
2. Enter the PIN from the SMS → **Submit PIN**. The proxy calls `submitPin`;
   pin-auth validates the PIN then calls the EVINA sidecar `verify`:
   - `✅ SUCCESS` — PIN correct **and** EVINA allowed.
   - `🚫 Blocked (HTTP 403)` — EVINA verdict was not allowed.

The raw pin-auth response is shown at the bottom for debugging.

---

## Troubleshooting

The app logs every round trip with a correlation id, timing, HTTP status, and
whether `evinaScript` was present (secrets are redacted). Set `LOG_LEVEL=debug`
for the most detail.

**Check reachability first** (built-in, no shell needed): open
`http://<host>:<port>/diag`. It POSTs to pin-auth and reports whether the host
is reachable and what status came back. `/health` confirms the app itself is up.

| Symptom | Likely cause |
|---|---|
| `/diag` reachable:false | `PIN_AUTH_BASE` wrong, DNS/firewall, or TLS cert (try `INSECURE_TLS=1` for internal certs) |
| `App authentication failure` | `PIN_AUTH_APP_ID` is not a valid app in pin-auth's DB |
| `MalformedJsonException: Unterminated string` in pin-auth | token not base64url-unpadded (this app already does it correctly) |
| subscribe OK but `evinaScript` empty | EVINA disabled in pin-auth, or sidecar unreachable (fails open) |
| Always `Blocked (403)` | expected for scripted/headless clicks — test by hand on a real browser/device |
| `credential MISSING` banner | neither `PIN_AUTH_APP_ID` nor `PIN_AUTH_JWT` set in `.env` |
| HTTP 405 from a manual `curl` | you used GET; the endpoint is POST-only (this is normal, proves reachability) |

> Reachability was already confirmed from the office network: a manual GET to
> the subscribe URL returned `HTTP 405 Method Not Allowed` with `Allow: POST`,
> which proves the host and TLS path are open.

---

## Project layout

```
evina-pin-test-fe/
├─ package.json
├─ tsconfig.json
├─ .env.example          # copy to .env
├─ scripts/copy-public.mjs
└─ src/
   ├─ server.ts          # express proxy + serves the UI, /health, /diag
   ├─ config.ts          # loads .env, builds X-JWT-Assertion from app id
   ├─ logger.ts          # structured logging + secret redaction
   ├─ pinAuth.ts         # calls subscribe / submitPin
   └─ public/index.html  # the frontend
```

> **Safety:** `subscribe` sends a real SMS and does real subscription work on a
> live service. Use a test MSISDN you control and coordinate with your team to
> avoid real charges.

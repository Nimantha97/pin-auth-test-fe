# PIN Subscription with EVINA Anti-Fraud — Frontend Integration Guide

This is the **new version** of the existing [PIN Subscription API](https://docs.ideabiz.lk/APIs/Main/PIN-Subscription/).
The `subscribe` / `submitPin` flow is unchanged. The only addition is **EVINA**, an
anti-fraud kit that scores the real user interaction on your **PIN submit button** before
the subscription is confirmed.

From your side, there are only **two new things to do** in your frontend:

1. Give your **PIN submit button a known target element** (a CSS selector) that EVINA can watch.
2. Take the **EVINA script** returned by `subscribe`, decode it, and inject it into your page.

Everything else — endpoints, request/response shapes, authorization — works the same as
the existing PIN Subscription API.

---

## Requirements

### Authorization

All API requests to ideabiz.lk require an `Authorization` header with a Bearer access
token. Generate and refresh your token as described in
[Token Management](https://docs.ideabiz.lk/Getting_Started/Token_Manegment).

```
Content-Type: application/json
Authorization: Bearer [access token]
Accept: application/json
```

> The access token comes from **your** ideabiz app store application. Keep it on your
> **server side** — never embed it in browser code.

---

## API Flow

1. Send a **Subscribe** request and capture the server reference `serverRef`.
2. **Inject the EVINA script** returned in the subscribe response so the kit watches your
   submit button. *(new in this version)*
3. Send a **Submit PIN** request with the PIN the user received and the `serverRef` to get
   the subscription status.

```
Your frontend ──> Your backend ──> ideabiz PIN API ──> EVINA
```

Because the browser must not hold the access token, your page talks to **your own
backend**, which adds the `Authorization` header and forwards to ideabiz.

---

## 1. Subscribe Request

**URL**

```
POST https://ideabiz.lk/apicall/pin/subscription/v2/subscribe
```

**Request**

```json
{
  "method": "AndroidApp",
  "msisdn": "94777339033"
}
```

**Response**

The response is the same as the existing API, **plus** a Base64-encoded `evinaScript`
field inside `data`:

```json
{
  "statusCode": "SUCCESS",
  "message": null,
  "data": {
    "status": "PENDING_AUTH",
    "serverRef": "f07927b4030048be99dc051314b5f40e",
    "msisdn": "tel:+94777339033",
    "method": "ANC",
    "evinaScript": "PHNjcmlwdD4uLi4= (Base64-encoded EVINA kit)"
  }
}
```

Keep the `serverRef` — you need it for Submit PIN. The `evinaScript` is handled in
[section 3](#3-set-up-the-evina-script-new).

> **Micro Services (Subscriptions):** if you subscribe to a specific service, include
> `serviceId` in the request body, exactly as in the existing API.

---

## 2. Set up the target element (new)

EVINA scores the **real user interaction** on your PIN submit button. To do that, the kit
needs a stable element to watch, identified by a **CSS selector** (the "target selector").

Give your submit button an `id` and make sure that selector is the one agreed with us for
your service (we configure the same selector on the pin-auth side). The default is
`#submit-pin`.

```html
<!-- EVINA attaches to this element to score the interaction.
     The id MUST match the target selector configured for your service. -->
<button id="submit-pin">Submit PIN</button>
```

Rules:

- The button's selector, the selector you inject the kit for, and the selector configured
  on our side must **all be the same**.
- If they don't match, EVINA watches the wrong element (or nothing) and the submit is
  **blocked** because it never saw a legitimate interaction.
- EVINA scores **real human** input. Scripted, headless, or automated clicks are expected
  to be blocked — always test by hand on a real browser or device.

---

## 3. Set up the EVINA script (new)

`data.evinaScript` is the EVINA kit, **Base64-encoded (UTF-8)** for safe transport. After
a successful subscribe, your page must:

1. Read `data.evinaScript` from the response.
2. **Base64-decode** it back to raw JavaScript (UTF-8 aware).
3. Inject it as an **inline** `<script>` so the kit initializes and starts watching your
   submit button.

### 3.1 Decode helper (UTF-8 aware)

A plain `atob` is not enough — decode as UTF-8 so non-ASCII characters survive.

```js
function decodeEvinaScript(b64) {
  var binary = atob(b64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
```

### 3.2 Inject after a successful subscribe

```js
// `data` is the `data` object from the subscribe response.
var serverRef = data.serverRef;            // keep this for Submit PIN

if (data.evinaScript) {
  var scriptText = decodeEvinaScript(data.evinaScript);

  var s = document.createElement('script');
  s.textContent = scriptText;              // inline the decoded kit — do NOT use s.src
  document.head.appendChild(s);            // kit initializes and watches your button
} else {
  // No evinaScript => EVINA is disabled or unavailable for this request.
}
```

> **Common mistake:** injecting the Base64 string directly, or setting `script.src` to it.
> You must decode first and set `script.textContent`, otherwise nothing runs.

---

## 4. Submit PIN

**URL**

```
POST https://ideabiz.lk/apicall/pin/subscription/v2/submitPin
```

**Request**

```json
{
  "pin": "520972",
  "serverRef": "f07927b4030048be99dc051314b5f40e"
}
```

The user must click the **watched submit button** (the target element from section 2) so
EVINA can score the interaction. When you call Submit PIN, ideabiz validates the PIN and
then checks the EVINA verdict.

**Sample success response**

```json
{
  "statusCode": "SUCCESS",
  "message": "Subscription Status",
  "data": {
    "status": "SUBSCRIBED",
    "serverRef": "8f27e17b51de4b64baa6cd5525506516",
    "msisdn": "tel:+94777123456",
    "method": "ANC"
  }
}
```

**Blocked by EVINA**

If EVINA's verdict is "not allowed", the request is blocked (HTTP 403). This is expected
for scripted or non-human interactions.

```json
{
  "statusCode": "ERROR",
  "message": "Blocked by anti-fraud",
  "data": null
}
```

**Other error responses** (same as the existing API):

```json
{ "statusCode": "ERROR", "message": "Wrong PIN", "data": null }
```
```json
{ "statusCode": "ERROR", "message": "Max attempt exceeded", "data": null }
```

---

## 5. Detailed PIN Request (optional)

As in the existing API, you may include `pinMeta` in the subscribe request to send extra
details about the user. This helps the Ideabiz team support customer queries. The fields
(`client`, `device`, `version`, `appCode`, `headers`, `remoteRef`, `utmSource`, `IP`) are
unchanged — see the
[PIN Subscription API docs](https://docs.ideabiz.lk/APIs/Main/PIN-Subscription/).

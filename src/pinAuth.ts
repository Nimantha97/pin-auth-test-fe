/**
 * pin-auth client — talks to the REAL Java pin-auth v2 subscribe / submitPin.
 *
 * It adds the auth header server-side (never in the browser), forwards the
 * request, logs the full round trip (secrets redacted) with a correlation id,
 * and returns pin-auth's response verbatim — including `data.evinaScript`,
 * which the browser injects so the EVINA kit watches the submit button.
 *
 * The v2 controller requires an `X-JWT-Assertion` header and reads only the
 * `applicationid` claim from it (no signature check). AUTH_MODE=bearer is kept
 * as a fallback for the public ideabiz.lk gateway, which uses OAuth instead.
 */

import { config } from "./config.js";
import { log, newCorrelationId } from "./logger.js";

export interface PinAuthResult {
  /** HTTP status pin-auth returned (or a synthetic 5xx on transport failure). */
  status: number;
  /** Parsed JSON body, or a synthetic error object when the body wasn't JSON. */
  body: Record<string, unknown>;
  /** Correlation id tying this call to its log lines. */
  cid: string;
}

/** Client details forwarded so EVINA sees the real IP / User-Agent. */
export interface ClientInfo {
  ip?: string;
  userAgent?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// Bearer token auto-refresh (only used when AUTH_MODE=bearer and
// CONSUMER_KEY + CONSUMER_SECRET are set instead of a static BEARER_TOKEN)
// ---------------------------------------------------------------------------
let cachedToken: { value: string; expiresAt: number } | null = null;

async function fetchBearerToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) return cachedToken.value;

  const credentials = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
  const resp = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + credentials,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token endpoint returned HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = (await resp.json()) as { access_token: string; expires_in?: number };
  const expiresIn = (json.expires_in ?? 3600) - 60; // refresh 60 s before expiry
  cachedToken = { value: json.access_token, expiresAt: now + expiresIn * 1000 };
  log.info("Bearer token refreshed", { expiresInSec: expiresIn });
  return cachedToken.value;
}

/** Build the auth headers for the configured mode. */
async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.authMode === "bearer") {
    const token = config.bearerToken || await fetchBearerToken();
    if (token) headers["Authorization"] = "Bearer " + token;
  } else {
    if (config.jwtAssertion) headers["X-JWT-Assertion"] = config.jwtAssertion;
  }
  if (config.language) headers["language"] = config.language;
  return headers;
}

/**
 * The INSECURE_TLS escape hatch sets NODE_TLS_REJECT_UNAUTHORIZED globally.
 * We flip it per-process at startup via this helper (called from config use).
 */
function applyTlsSetting(): void {
  if (config.insecureTls) {
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
  }
}
applyTlsSetting();

/** Low-level JSON POST to pin-auth with logging + timing. */
async function postJson(url: string, payload: unknown, cid: string): Promise<PinAuthResult> {
  const headers = await authHeaders();
  const started = Date.now();

  log.info("→ pin-auth request", { url, payload }, cid);
  log.debug("→ pin-auth request headers", { headers }, cid);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const ms = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    log.error("✗ pin-auth transport failure", { url, ms, error: message }, cid);
    return {
      status: 502,
      body: {
        statusCode: "ERROR",
        message: "Could not reach pin-auth: " + message,
        data: null,
      },
      cid,
    };
  }

  const ms = Date.now() - started;
  const text = await resp.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    log.warn("pin-auth returned non-JSON body", { status: resp.status, snippet: text.slice(0, 300) }, cid);
    body = {
      statusCode: "ERROR",
      message: "Non-JSON response from pin-auth (HTTP " + resp.status + ")",
      raw: text.slice(0, 2000),
      data: null,
    };
  }

  // Log an evinaScript-aware summary without dumping the whole (large) kit.
  const data = (body["data"] ?? null) as Record<string, unknown> | null;
  const evinaScript = data && typeof data["evinaScript"] === "string" ? (data["evinaScript"] as string) : null;
  log.info(
    "← pin-auth response",
    {
      url,
      httpStatus: resp.status,
      ms,
      statusCode: body["statusCode"],
      message: body["message"] ?? null,
      serverRef: data?.["serverRef"] ?? null,
      evinaScriptPresent: Boolean(evinaScript),
      evinaScriptLen: evinaScript ? evinaScript.length : 0,
    },
    cid,
  );

  // When EVINA returns a script (subscribe path), log a preview so it's visible
  // in the server terminal. Full script still goes to the browser verbatim.
  if (evinaScript) {
    log.debug(
      "← pin-auth evinaScript",
      {
        length: evinaScript.length,
        preview: evinaScript.slice(0, 300) + (evinaScript.length > 300 ? " …[truncated]" : ""),
      },
      cid,
    );
  }

  return { status: resp.status, body, cid };
}

/**
 * subscribe — request a PIN. Builds the SubscribeRequestV2 shape the controller
 * expects: { msisdn, serviceId?, vendorRef, client{ type, ip, userAgent, url } }.
 * pin-auth sends the SMS and returns serverRef + data.evinaScript.
 */
export async function subscribe(msisdn: string, client: ClientInfo): Promise<PinAuthResult> {
  const cid = newCorrelationId();
  const cleanMsisdn = msisdn.replace(/\D/g, "");

  const payload: Record<string, unknown> = {
    msisdn: cleanMsisdn,
    ...(config.serviceId ? { serviceId: config.serviceId } : {}),
    vendorRef: "live-test-" + Date.now(),
    client: {
      type: "WEB",
      ip: client.ip ?? "",
      userAgent: client.userAgent ?? "evina-pin-test-fe",
      url: client.url ?? "",
    },
  };

  return postJson(config.subscribeUrl, payload, cid);
}

/**
 * submitPin — submit the PIN the user received. Shape: { pin, serverRef, vendorRef }.
 * pin-auth validates the PIN, then calls the EVINA sidecar's verify. On an
 * EVINA block it returns HTTP 403 "Blocked by anti-fraud".
 */
export async function submitPin(pin: string, serverRef: string): Promise<PinAuthResult> {
  const cid = newCorrelationId();
  const payload = { pin, serverRef, vendorRef: "live-test" };
  return postJson(config.submitUrl, payload, cid);
}

/**
 * Reachability diagnostic. POSTs an intentionally-empty body to subscribe just
 * to confirm the network path + TLS to pin-auth. A 4xx/5xx with a real HTTP
 * status still proves reachability; only a transport error means unreachable.
 */
export async function diagnose(): Promise<{ reachable: boolean; detail: unknown }> {
  const cid = newCorrelationId();
  log.info("Running reachability diagnostic against pin-auth", { url: config.subscribeUrl }, cid);
  try {
    const resp = await fetch(config.subscribeUrl, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ msisdn: "" }),
    });
    const text = await resp.text();
    log.info("Diagnostic: pin-auth responded", { httpStatus: resp.status }, cid);
    return {
      reachable: true,
      detail: { httpStatus: resp.status, snippet: text.slice(0, 300) },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Diagnostic: pin-auth unreachable", { error: message }, cid);
    return { reachable: false, detail: { error: message } };
  }
}

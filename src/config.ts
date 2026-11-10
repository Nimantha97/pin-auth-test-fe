/**
 * Configuration loader + validator for the EVINA pin-auth live-test frontend.
 *
 * All runtime behaviour is driven by `.env` (next to package.json). This module
 * loads it, resolves sensible defaults, builds the X-JWT-Assertion header from
 * the app id (mirroring pin-auth's own JWT.getJWTforApp), and logs the resolved
 * config at startup (secrets redacted) so misconfiguration is obvious.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log, setLogLevel } from "./logger.js";

// Not named `__dirname`: Netlify's ESM bundler injects its own `__dirname` shim.
const configDir = dirname(fileURLToPath(import.meta.url));

/** Minimal .env loader — no external dependency. Does not override real env vars. */
function loadDotEnv(path: string): void {
  try {
    const content = readFileSync(path, "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // Strip surrounding quotes if present.
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no .env file — rely on the real environment */
  }
}

loadDotEnv(resolve(configDir, "../.env"));

export type AuthMode = "jwt-assertion" | "bearer";

function env(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

/**
 * Build the X-JWT-Assertion header pin-auth accepts, mirroring pin-auth's own
 * JWT.getJWTforApp(appId). pin-auth's JWT.tokenInfo() base64url-decodes the
 * payload (2nd segment) to read `applicationid` and does NOT verify the
 * signature, so this unsigned WSO2-style token is accepted.
 *
 * IMPORTANT: JWT segments must be base64url WITHOUT "=" padding. Standard
 * base64 (with padding) makes pin-auth's decoder truncate the JSON and throw
 * "Unterminated string" in JWT.tokenInfo().
 */
export function buildJwtForApp(appId: string): string {
  const claims =
    '{"iss":"wso2.org/products/am","exp":0,' +
    '"http://wso2.org/claims/subscriber":"admin",' +
    '"http://wso2.org/claims/applicationid":"' + appId + '",' +
    '"http://wso2.org/claims/applicationname":"AdminAPI",' +
    '"http://wso2.org/claims/applicationtier":"Unlimited",' +
    '"http://wso2.org/claims/apicontext":"/smsmessaging",' +
    '"http://wso2.org/claims/version":"2",' +
    '"http://wso2.org/claims/tier":"6000TPM",' +
    '"http://wso2.org/claims/keytype":"PRODUCTION",' +
    '"http://wso2.org/claims/usertype":"APPLICATION",' +
    '"http://wso2.org/claims/enduser":"anonymous",' +
    '"http://wso2.org/claims/enduserTenantId":"-1234",' +
    '"http://wso2.org/claims/emailaddress":"info@ideabiz.lk",' +
    '"http://wso2.org/claims/givenname":"Dialog",' +
    '"http://wso2.org/claims/lastname":"IdeaBiz",' +
    '"http://wso2.org/claims/role":"admin,Internal/subscriber"}';
  const header = Buffer.from('{"typ":"JWT","alg":"none"}', "utf8").toString("base64url");
  const payload = Buffer.from(claims, "utf8").toString("base64url");
  return header + "." + payload;
}

export interface AppConfig {
  pinAuthBase: string;
  subscribePath: string;
  submitPath: string;
  subscribeUrl: string;
  submitUrl: string;
  insecureTls: boolean;
  authMode: AuthMode;
  appId: string;
  /** The resolved X-JWT-Assertion value (built or pasted), or "" if not applicable. */
  jwtAssertion: string;
  bearerToken: string;
  consumerKey: string;
  consumerSecret: string;
  tokenUrl: string;
  serviceId: string;
  language: string;
  targetSelector: string;
  port: number;
  /** Which source produced the auth credential — for logging/UI. */
  authSource: string;
}

function buildConfig(): AppConfig {
  setLogLevel(env("LOG_LEVEL", "info"));

  const pinAuthBase = env("PIN_AUTH_BASE", "https://idm-op-app-01.ideabiz.lk/ib-int/pin-api/v1").replace(/\/+$/, "");
  const subscribePath = env("SUBSCRIBE_PATH", "/pin/subscription/v2/subscribe");
  const submitPath = env("SUBMIT_PATH", "/pin/subscription/v2/submitPin");

  const authModeRaw = env("AUTH_MODE", "jwt-assertion").toLowerCase();
  const authMode: AuthMode = authModeRaw === "bearer" ? "bearer" : "jwt-assertion";

  const appId = env("PIN_AUTH_APP_ID");
  const jwtOverride = env("PIN_AUTH_JWT");
  const bearerToken = env("BEARER_TOKEN");
  const consumerKey = env("CONSUMER_KEY");
  const consumerSecret = env("CONSUMER_SECRET");
  const tokenUrl = env("TOKEN_URL", "https://ideabiz.lk/apicall/token");

  let jwtAssertion = "";
  let authSource = "none";

  if (authMode === "jwt-assertion") {
    if (jwtOverride) {
      jwtAssertion = jwtOverride;
      authSource = "PIN_AUTH_JWT (pasted)";
    } else if (appId) {
      jwtAssertion = buildJwtForApp(appId);
      authSource = "built from PIN_AUTH_APP_ID=" + appId;
    }
  } else {
    if (bearerToken) authSource = "BEARER_TOKEN";
    else if (consumerKey && consumerSecret) authSource = "CONSUMER_KEY+SECRET (auto-refresh)";
    else authSource = "none";
  }

  return {
    pinAuthBase,
    subscribePath,
    submitPath,
    subscribeUrl: pinAuthBase + subscribePath,
    submitUrl: pinAuthBase + submitPath,
    insecureTls: env("INSECURE_TLS") === "1",
    authMode,
    appId,
    jwtAssertion,
    bearerToken,
    consumerKey,
    consumerSecret,
    tokenUrl,
    serviceId: env("PIN_AUTH_SERVICE_ID"),
    language: env("LANGUAGE"),
    targetSelector: env("TARGET_SELECTOR", "#submit-pin"),
    port: Number(env("PORT", "4100")) || 4100,
    authSource,
  };
}

export const config: AppConfig = buildConfig();

/** True when we have a usable credential for the selected auth mode. */
export function hasCredential(): boolean {
  if (config.authMode === "bearer") {
    return config.bearerToken.length > 0 || (config.consumerKey.length > 0 && config.consumerSecret.length > 0);
  }
  return config.jwtAssertion.length > 0;
}

/** Log the resolved config at startup (secrets redacted) and warn on gaps. */
export function logConfig(): void {
  log.info("Resolved configuration", {
    pinAuthBase: config.pinAuthBase,
    subscribeUrl: config.subscribeUrl,
    submitUrl: config.submitUrl,
    authMode: config.authMode,
    authSource: config.authSource,
    appId: config.appId || "(none)",
    serviceId: config.serviceId || "(app default)",
    language: config.language || "(none)",
    targetSelector: config.targetSelector,
    insecureTls: config.insecureTls,
    port: config.port,
  });

  if (!hasCredential()) {
    if (config.authMode === "jwt-assertion") {
      log.warn("No credential: set PIN_AUTH_APP_ID (recommended) or PIN_AUTH_JWT in .env — subscribe will fail.");
    } else {
      log.warn("No credential: AUTH_MODE=bearer but BEARER_TOKEN is empty — subscribe will fail.");
    }
  }
  if (config.insecureTls) {
    log.warn("INSECURE_TLS=1 — TLS certificate verification is DISABLED. Use only for internal testing.");
  }
}

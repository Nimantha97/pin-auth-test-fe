/**
 * EVINA pin-auth live-test frontend + proxy.
 * =========================================
 *
 * This single process:
 *   1. Serves a small HTML frontend (public/index.html) via your DNS once
 *      deployed. The page lets a tester enter an MSISDN, request a PIN, enter
 *      the PIN, and see the result.
 *   2. Exposes same-origin proxy routes the page calls. The proxy adds the
 *      X-JWT-Assertion header SERVER-SIDE (so no secret ever reaches the
 *      browser) and forwards to the real pin-auth v2 endpoints.
 *   3. Returns pin-auth's response verbatim — including data.evinaScript, which
 *      the page injects so the EVINA kit watches the submit button.
 *
 *   Browser ──> this proxy ──> pin-auth (Java) ──> EVINA sidecar ──> EVINA
 *
 * It also exposes /health (is the app up) and /diag (can the app reach
 * pin-auth) so troubleshooting after deployment is quick.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config, hasCredential, logConfig } from "./config.js";
import { log, newCorrelationId } from "./logger.js";
import { subscribe, submitPin, diagnose } from "./pinAuth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// --- Per-request access log (correlation id attached to each incoming call) ---
app.use((req, _res, next) => {
  if (req.path.startsWith("/api") || req.path === "/diag") {
    log.debug("HTTP in", { method: req.method, path: req.path });
  }
  next();
});

/** Extract the real client IP so EVINA sees the end user's address. */
function clientIp(req: express.Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0]!.trim();
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

// ---------------------------------------------------------------------------
// Proxy: subscribe
// ---------------------------------------------------------------------------
app.post("/api/subscribe", (req, res) => {
  void (async () => {
    const { msisdn } = (req.body ?? {}) as { msisdn?: string };

    if (!msisdn || msisdn.replace(/\D/g, "").length < 9) {
      res.status(400).json({ statusCode: "ERROR", message: "Invalid MSISDN", data: null });
      return;
    }
    if (!hasCredential()) {
      res.status(500).json({
        statusCode: "ERROR",
        message:
          config.authMode === "jwt-assertion"
            ? "No credential: set PIN_AUTH_APP_ID (or PIN_AUTH_JWT) in .env"
            : "No credential: set BEARER_TOKEN in .env (AUTH_MODE=bearer)",
        data: null,
      });
      return;
    }

    // Debug: show exactly how the client IP / UA that EVINA will see was derived.
    log.info("[EVINA-DEBUG] subscribe client context", {
      chosenIp: clientIp(req),
      xForwardedFor: req.headers["x-forwarded-for"] ?? null,
      socketRemoteAddress: req.socket.remoteAddress ?? null,
      isLoopback: /^(127\.|::1$)/.test(clientIp(req)),
      userAgent: req.headers["user-agent"] ?? null,
      referer: req.headers["referer"] ?? null,
      acceptLanguage: req.headers["accept-language"] ?? null,
      serviceId: config.serviceId || "(app default)",
      authMode: config.authMode,
    });

    const result = await subscribe(msisdn, {
      ip: clientIp(req),
      userAgent: req.headers["user-agent"],
      url: typeof req.headers["referer"] === "string" ? req.headers["referer"] : "",
    });
    res.status(result.status).json(result.body);
  })().catch((err) => {
    log.error("Unhandled error in /api/subscribe", { error: String(err) });
    res.status(500).json({ statusCode: "ERROR", message: "Internal proxy error", data: null });
  });
});

// ---------------------------------------------------------------------------
// Proxy: submitPin
// ---------------------------------------------------------------------------
app.post("/api/submitPin", (req, res) => {
  void (async () => {
    const { pin, serverRef } = (req.body ?? {}) as { pin?: string; serverRef?: string };

    if (!pin || !serverRef) {
      res.status(400).json({ statusCode: "ERROR", message: "pin and serverRef are required", data: null });
      return;
    }

    const result = await submitPin(pin, serverRef);
    res.status(result.status).json(result.body);
  })().catch((err) => {
    log.error("Unhandled error in /api/submitPin", { error: String(err) });
    res.status(500).json({ statusCode: "ERROR", message: "Internal proxy error", data: null });
  });
});

// ---------------------------------------------------------------------------
// Config probe (frontend shows what it's pointing at + warnings)
// ---------------------------------------------------------------------------
app.get("/api/config", (_req, res) => {
  res.json({
    pinAuthBase: config.pinAuthBase,
    subscribeUrl: config.subscribeUrl,
    submitUrl: config.submitUrl,
    authMode: config.authMode,
    authSource: config.authSource,
    credentialConfigured: hasCredential(),
    serviceId: config.serviceId || "(app default)",
    targetSelector: config.targetSelector,
    language: config.language || "(none)",
  });
});

// ---------------------------------------------------------------------------
// Health + diagnostics
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptimeSec: Math.round(process.uptime()) });
});

app.get("/diag", (_req, res) => {
  void (async () => {
    const cid = newCorrelationId();
    const result = await diagnose();
    res.json({
      cid,
      pinAuthBase: config.pinAuthBase,
      subscribeUrl: config.subscribeUrl,
      authMode: config.authMode,
      authSource: config.authSource,
      credentialConfigured: hasCredential(),
      reachable: result.reachable,
      detail: result.detail,
    });
  })().catch((err) => {
    log.error("Unhandled error in /diag", { error: String(err) });
    res.status(500).json({ reachable: false, detail: { error: String(err) } });
  });
});

// ---------------------------------------------------------------------------
// Frontend — serve the HTML page, injecting the target selector at request time
// ---------------------------------------------------------------------------
const PAGE_PATH = resolve(__dirname, "./public/index.html");

function renderPage(): string {
  let html = readFileSync(PAGE_PATH, "utf8");
  // Expose the configured selector to the page (so the submit button id matches).
  html = html.replace("{{TARGET_SELECTOR}}", config.targetSelector);
  return html;
}

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderPage());
});

// ===========================================================================
// FRAUD-SIMULATION HARNESS (Option B) — SAFE TO DELETE
// ---------------------------------------------------------------------------
// Standalone throwaway test page that drives the SAME real subscribe/submitPin
// endpoints but submits the PIN via a scripted (non-human) click so EVINA
// scores the session as fraud and returns its block verdict.
// To remove this feature: delete this route block AND src/public/fraud-test.html.
// Nothing in the production path depends on it.
// ===========================================================================
const FRAUD_PAGE_PATH = resolve(__dirname, "./public/fraud-test.html");

function renderFraudPage(): string {
  let html = readFileSync(FRAUD_PAGE_PATH, "utf8");
  html = html.replace("{{TARGET_SELECTOR}}", config.targetSelector);
  return html;
}

app.get("/fraud-test", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderFraudPage());
});
// ===================== END FRAUD-SIMULATION HARNESS ========================

// ---------------------------------------------------------------------------
// Start — bind 0.0.0.0 so the page is reachable via DNS once deployed.
// ---------------------------------------------------------------------------
logConfig();

app.listen(config.port, "0.0.0.0", () => {
  log.info(`EVINA pin-auth live-test frontend listening on 0.0.0.0:${config.port}`);
  log.info(`Open the UI at http://<this-host>:${config.port}/  (or via your DNS)`);
  log.info(`Forwarding to pin-auth: ${config.subscribeUrl}`);
  if (!hasCredential()) {
    log.warn("Startup: no credential configured — subscribe will fail until .env is set.");
  }
});

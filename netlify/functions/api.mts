/**
 * Netlify Function equivalent of the Express routes in src/server.ts.
 * Reuses src/config.ts and src/pinAuth.ts unchanged, so behaviour (headers,
 * payloads, logging) is identical to the local server. Config comes from the
 * Netlify environment variables (there is no .env file on Netlify).
 *
 * Routes (see `config.path` below + netlify.toml redirects):
 *   POST /api/subscribe   POST /api/submitPin   GET /api/config
 *   GET  /diag            GET  /health
 */

import { config as appConfig, hasCredential, logConfig } from "../../src/config.js";
import { subscribe, submitPin, diagnose } from "../../src/pinAuth.js";

export const config = {
  path: ["/api/subscribe", "/api/submitPin", "/api/config", "/diag", "/health"],
};

let logged = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default async (req: Request, context: { ip?: string }): Promise<Response> => {
  if (!logged) {
    logConfig();
    logged = true;
  }
  const path = new URL(req.url).pathname;

  if (req.method === "GET" && path === "/health") {
    return json({ status: "ok" });
  }

  if (req.method === "GET" && path === "/api/config") {
    return json({
      pinAuthBase: appConfig.pinAuthBase,
      subscribeUrl: appConfig.subscribeUrl,
      submitUrl: appConfig.submitUrl,
      authMode: appConfig.authMode,
      authSource: appConfig.authSource,
      credentialConfigured: hasCredential(),
      serviceId: appConfig.serviceId || "(app default)",
      targetSelector: appConfig.targetSelector,
      language: appConfig.language || "(none)",
    });
  }

  if (req.method === "GET" && path === "/diag") {
    const result = await diagnose();
    return json({
      pinAuthBase: appConfig.pinAuthBase,
      subscribeUrl: appConfig.subscribeUrl,
      authMode: appConfig.authMode,
      authSource: appConfig.authSource,
      credentialConfigured: hasCredential(),
      reachable: result.reachable,
      detail: result.detail,
    });
  }

  if (req.method === "POST" && path === "/api/subscribe") {
    const { msisdn } = (await req.json().catch(() => ({}))) as { msisdn?: string };
    if (!msisdn || msisdn.replace(/\D/g, "").length < 9) {
      return json({ statusCode: "ERROR", message: "Invalid MSISDN", data: null }, 400);
    }
    if (!hasCredential()) {
      return json(
        {
          statusCode: "ERROR",
          message:
            appConfig.authMode === "jwt-assertion"
              ? "No credential: set PIN_AUTH_APP_ID (or PIN_AUTH_JWT) in Netlify env vars"
              : "No credential: set BEARER_TOKEN in Netlify env vars (AUTH_MODE=bearer)",
          data: null,
        },
        500,
      );
    }
    const xff = req.headers.get("x-forwarded-for");
    const ip = context.ip ?? (xff ? xff.split(",")[0]!.trim() : "");
    const result = await subscribe(msisdn, {
      ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
      url: req.headers.get("referer") ?? "",
    });
    return json(result.body, result.status);
  }

  if (req.method === "POST" && path === "/api/submitPin") {
    const { pin, serverRef } = (await req.json().catch(() => ({}))) as { pin?: string; serverRef?: string };
    if (!pin || !serverRef) {
      return json({ statusCode: "ERROR", message: "pin and serverRef are required", data: null }, 400);
    }
    const result = await submitPin(pin, serverRef);
    return json(result.body, result.status);
  }

  return json({ statusCode: "ERROR", message: "Not found", data: null }, 404);
};

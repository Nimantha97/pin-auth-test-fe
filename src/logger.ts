/**
 * Structured logger with level filtering and secret redaction.
 *
 * Designed for troubleshooting a live integration: every line is timestamped,
 * carries a level, and optionally a correlation id so a single browser action
 * (subscribe / submitPin) can be traced end to end through the proxy.
 *
 * Secrets (JWT / bearer token / PIN) are redacted before anything is logged.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: string | undefined): void {
  const normalized = (level ?? "").toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    currentLevel = normalized;
  }
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Keys whose values must never appear in logs. */
const SECRET_KEYS = new Set([
  "x-jwt-assertion",
  "authorization",
  "pin",
  "bearer_token",
  "pin_auth_jwt",
  "token",
  "password",
]);

/** Mask a secret value, keeping only a short prefix so you can tell two tokens apart. */
function maskSecret(value: unknown): string {
  const str = String(value);
  if (str.length <= 8) return "***";
  return str.slice(0, 6) + "…[redacted, len=" + str.length + "]";
}

/** Recursively redact secret fields in an object/array for safe logging. */
export function redact(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map(redact);
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      if (SECRET_KEYS.has(key.toLowerCase())) {
        out[key] = maskSecret(val);
      } else {
        out[key] = redact(val);
      }
    }
    return out;
  }
  return input;
}

function emit(level: LogLevel, cid: string | undefined, msg: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const cidPart = cid ? ` [${cid}]` : "";
  let line = `${ts} ${tag}${cidPart} ${msg}`;

  if (extra !== undefined) {
    try {
      line += " " + JSON.stringify(redact(extra));
    } catch {
      line += " [unserializable extra]";
    }
  }

  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line);
}

export const log = {
  debug: (msg: string, extra?: unknown, cid?: string) => emit("debug", cid, msg, extra),
  info: (msg: string, extra?: unknown, cid?: string) => emit("info", cid, msg, extra),
  warn: (msg: string, extra?: unknown, cid?: string) => emit("warn", cid, msg, extra),
  error: (msg: string, extra?: unknown, cid?: string) => emit("error", cid, msg, extra),
};

/** Short random correlation id to tie a browser action to its proxy + pin-auth calls. */
export function newCorrelationId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

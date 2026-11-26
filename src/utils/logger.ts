import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensurePrivateDirectory, privateAtomicWrite, restrictPath } from "../credentials/secure-file.js";
import { extractHttpStatus, extractQboFault } from "./errors.js";
import { redactText } from "./redact.js";
import { toolDefinitions } from "../tools/definitions.js";

const requestContext = new AsyncLocalStorage<{ tid: string | null }>();
const tools = new Set(toolDefinitions.map(t => t.name));
const LOG_NAME = "quickbooks-mcp.log";
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const readyDirectories = new Set<string>();

export function withLogContext<T>(work: () => T): T { return requestContext.run({ tid: null }, work); }
export function getLastIntuitTid(): string | null { return requestContext.getStore()?.tid || null; }
export function captureIntuitTid(tid: string): void {
  const context = requestContext.getStore();
  if (context && /^[a-z0-9-]{8,128}$/i.test(tid) && redactText(tid) === tid) context.tid = tid;
}

function directory(): string { return process.env.QBO_LOG_DIR || join(homedir(), ".quickbooks-mcp", "logs"); }
export function getLogFilePath(): string { return join(directory(), LOG_NAME); }

/** An allowlist, not recursive redaction: legacy payloads never survive migration. */
export function diagnosticMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof input.timestamp === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.timestamp)) result.timestamp = input.timestamp;
  if (typeof input.tool === "string" && tools.has(input.tool)) result.tool = input.tool;
  if (input.outcome === "ok" || input.outcome === "failed") result.outcome = input.outcome;
  else if (input.level === "error") result.outcome = "failed";
  if (typeof input.status === "number" && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599) result.status = input.status;
  if (typeof input.fault_code === "string" && /^\d{1,6}$/.test(input.fault_code)) result.fault_code = input.fault_code;
  if (typeof input.intuit_tid === "string" && /^[a-z0-9-]{8,128}$/i.test(input.intuit_tid) && redactText(input.intuit_tid) === input.intuit_tid) result.intuit_tid = input.intuit_tid;
  return result;
}

export function migrateLogs(dir = directory()): void {
  ensurePrivateDirectory(dir);
  for (const name of readdirSync(dir)) {
    if (!/^quickbooks-mcp\.log(?:\.\d+)?$/.test(name)) continue;
    const path = join(dir, name);
    restrictPath(path);
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    const sanitized: string[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === "object" && !Array.isArray(entry)) sanitized.push(JSON.stringify(diagnosticMetadata(entry)));
      } catch { /* Discard unstructured legacy payloads. */ }
    }
    privateAtomicWrite(path, sanitized.length ? sanitized.join("\n") + "\n" : "");
  }
  readyDirectories.add(dir);
}

function writeLog(entry: Record<string, unknown>): void {
  try {
    const dir = directory();
    if (!readyDirectories.has(dir)) migrateLogs(dir);
    const path = join(dir, LOG_NAME);
    if (existsSync(path) && statSync(path).size >= MAX_LOG_SIZE) {
      for (let i = 4; i >= 1; i--) {
        const from = path + "." + i;
        const to = path + "." + (i + 1);
        if (existsSync(from)) { if (existsSync(to)) unlinkSync(to); renameSync(from, to); }
      }
      if (existsSync(path + ".1")) unlinkSync(path + ".1");
      renameSync(path, path + ".1");
    }
    if (!existsSync(path)) privateAtomicWrite(path, "");
    appendFileSync(path, JSON.stringify(diagnosticMetadata({ timestamp: new Date().toISOString(), ...entry })) + "\n", { mode: 0o600 });
  } catch { /* Diagnostic failures must not replay or fail an accounting write. */ }
}
export function logApiCall(toolName: string, intuitTid?: string | null): void {
  writeLog({ tool: toolName, outcome: "ok", intuit_tid: intuitTid });
}
export function logError(toolName: string, error: unknown, intuitTid?: string | null): void {
  writeLog({ tool: toolName, outcome: "failed", status: extractHttpStatus(error), fault_code: extractQboFault(error)?.errors[0]?.code, intuit_tid: intuitTid });
}

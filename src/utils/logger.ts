// Error and request logging for QuickBooks MCP server
// Logs are stored in ~/.quickbooks-mcp/logs/ for troubleshooting

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const LOG_DIR = path.join(os.homedir(), ".quickbooks-mcp", "logs");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB per log file
const MAX_LOG_FILES = 5;

let logReady = false;

function ensureLogDir(): void {
  if (logReady) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logReady = true;
  } catch {
    // If we can't create the log dir, logging is silently disabled
  }
}

function getLogPath(): string {
  return path.join(LOG_DIR, "quickbooks-mcp.log");
}

function rotateIfNeeded(): void {
  const logPath = getLogPath();
  try {
    const stat = fs.statSync(logPath);
    if (stat.size >= MAX_LOG_SIZE) {
      // Rotate: shift existing files
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const from = `${logPath}.${i}`;
        const to = `${logPath}.${i + 1}`;
        try { fs.renameSync(from, to); } catch { /* ignore */ }
      }
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // File doesn't exist yet, no rotation needed
  }
}

function writeLog(level: string, message: string, data?: Record<string, unknown>): void {
  ensureLogDir();
  if (!logReady) return;

  rotateIfNeeded();

  const timestamp = new Date().toISOString();
  const entry: Record<string, unknown> = {
    timestamp,
    level,
    message,
    ...data,
  };

  try {
    fs.appendFileSync(getLogPath(), JSON.stringify(entry) + "\n");
  } catch {
    // Logging should never crash the app
  }
}

// Track the most recent intuit_tid for troubleshooting
let lastIntuitTid: string | null = null;

/**
 * Get the most recently captured intuit_tid value.
 */
export function getLastIntuitTid(): string | null {
  return lastIntuitTid;
}

/**
 * Record an intuit_tid from a QuickBooks API response header.
 */
export function captureIntuitTid(tid: string): void {
  lastIntuitTid = tid;
  writeLog("info", "API response", { intuit_tid: tid });
}

/**
 * Log an API error with full context for troubleshooting.
 */
export function logError(
  toolName: string,
  error: unknown,
  intuitTid?: string | null,
): void {
  const errorInfo: Record<string, unknown> = { tool: toolName };

  if (intuitTid) {
    errorInfo.intuit_tid = intuitTid;
  }

  if (error instanceof Error) {
    errorInfo.error_message = error.message;
    errorInfo.error_name = error.name;
    errorInfo.stack = error.stack;
  } else if (typeof error === "object" && error !== null) {
    errorInfo.error = error;
  } else {
    errorInfo.error = String(error);
  }

  writeLog("error", `Tool ${toolName} failed`, errorInfo);
}

/**
 * Log a successful API call.
 */
export function logApiCall(toolName: string, intuitTid?: string | null): void {
  const data: Record<string, unknown> = { tool: toolName };
  if (intuitTid) data.intuit_tid = intuitTid;
  writeLog("info", `Tool ${toolName} succeeded`, data);
}

/**
 * Get the log file path (for sharing with support).
 */
export function getLogFilePath(): string {
  return getLogPath();
}

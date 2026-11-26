import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticMetadata, migrateLogs, withLogContext, captureIntuitTid, getLastIntuitTid, logError, getLogFilePath } from "../../src/utils/logger.js";
import { formatQboError } from "../../src/utils/errors.js";
import { redactText, registerSecrets } from "../../src/utils/redact.js";

describe("secret-safe diagnostics", () => {
  it("drops nested payloads, raw errors and unknown metadata fields", () => {
    const raw: Record<string, unknown> = { tool: "query", status: 401, fault_code: "3200", outcome: "failed", error: { config: { headers: { Authorization: "Bearer never-log-this" } } }, stack: "never-log-this", message: "never-log-this" };
    raw.self = raw;
    const metadata = diagnosticMetadata(raw);
    assert.deepEqual(metadata, { tool: "query", outcome: "failed", status: 401, fault_code: "3200" });
    assert.doesNotMatch(formatQboError(raw), /never-log-this/);
  });

  it("redacts registered secrets, bearer/basic headers, encoded URLs and token fields", () => {
    const secret = "synthetic+/secret";
    registerSecrets(secret);
    const text = redactText(secret + " " + encodeURIComponent(secret) + " Bearer abcdefghijk Basic YWJjZGVm client_secret=never-see-me https://example.test/callback?code=private-code&state=private-state");
    for (const value of [secret, encodeURIComponent(secret), "abcdefghijk", "YWJjZGVm", "never-see-me", "private-code", "private-state"]) assert.ok(!text.includes(value));
    const fault = { Fault: { Error: [{ code: "610", Message: "Invalid reference", Detail: "access_token=private-token" }] } };
    assert.match(formatQboError(fault), /610/);
    assert.doesNotMatch(formatQboError(fault), /private-token/);
  });

  it("isolates request identifiers between concurrent tool calls", async () => {
    const ids = await Promise.all(["request-11111111", "request-22222222"].map(id => withLogContext(async () => {
      assert.equal(getLastIntuitTid(), null);
      captureIntuitTid(id);
      await new Promise(resolve => setImmediate(resolve));
      return getLastIntuitTid();
    })));
    assert.deepEqual(ids, ["request-11111111", "request-22222222"]);
    assert.equal(getLastIntuitTid(), null);
  });

  it("removes historical raw payloads and emits only metadata for new failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "qb-log-test-"));
    const original = process.env.QBO_LOG_DIR;
    process.env.QBO_LOG_DIR = dir;
    try {
      writeFileSync(join(dir, "quickbooks-mcp.log"), JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", tool: "query", level: "error", error: { access_token: "legacy-secret" } }) + "\nlegacy-secret\n");
      writeFileSync(join(dir, "quickbooks-mcp.log.1"), JSON.stringify({ error: "legacy-secret" }) + "\n");
      migrateLogs(dir);
      logError("query", { status: 401, config: { authorization: "new-secret" } }, "request-33333333");
      const current = readFileSync(getLogFilePath(), "utf8");
      assert.doesNotMatch(current, /legacy-secret|new-secret|authorization/);
      assert.doesNotMatch(readFileSync(join(dir, "quickbooks-mcp.log.1"), "utf8"), /legacy-secret/);
      assert.match(current, /"status":401/);
      assert.match(current, /request-33333333/);
    } finally {
      if (original === undefined) delete process.env.QBO_LOG_DIR; else process.env.QBO_LOG_DIR = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

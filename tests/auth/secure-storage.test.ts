import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { LocalCredentialProvider, type KeychainEntry } from "../../src/credentials/local-provider.js";
import { privateAtomicWrite, restrictPath } from "../../src/credentials/secure-file.js";
import type { QBCredentials } from "../../src/credentials/types.js";

const fixture: QBCredentials = { client_id: "fixture-client", client_secret: "fixture-client-secret", access_token: "fixture-access", refresh_token: "fixture-refresh", company_id: "123", redirect_url: "https://example.test/callback" };
let directory: string;
let oldId: string | undefined;
let oldSecret: string | undefined;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "qb-storage-test-")));
  oldId = process.env.QBO_CLIENT_ID; oldSecret = process.env.QBO_CLIENT_SECRET;
  delete process.env.QBO_CLIENT_ID; delete process.env.QBO_CLIENT_SECRET;
});
afterEach(() => {
  if (oldId === undefined) delete process.env.QBO_CLIENT_ID; else process.env.QBO_CLIENT_ID = oldId;
  if (oldSecret === undefined) delete process.env.QBO_CLIENT_SECRET; else process.env.QBO_CLIENT_SECRET = oldSecret;
  // Only the unique directory allocated by this test is removed.
  assert.equal(dirname(directory), realpathSync(tmpdir()));
  rmSync(directory, { recursive: true, force: true });
});
function fakeEntry(): KeychainEntry {
  let text: string | null = null;
  return { getPassword: () => text, setPassword: value => { text = value; } };
}

describe("protected credential providers", () => {
  it("migrates Windows plaintext, verifies encryption, and preserves token updates", { skip: process.platform !== "win32" }, async () => {
    const path = join(directory, "credentials-é.json");
    writeFileSync(path, JSON.stringify(fixture));
    const provider = new LocalCredentialProvider({ path });
    assert.deepEqual(await provider.getCredentials(), fixture);
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(envelope.format, "quickbooks-mcp/dpapi");
    for (const secret of [fixture.client_secret, fixture.access_token, fixture.refresh_token]) assert.ok(!readFileSync(path, "utf8").includes(secret));
    const next = { ...fixture, access_token: "rotated-access", refresh_token: "rotated-refresh" };
    await provider.saveCredentials(next);
    assert.deepEqual(await new LocalCredentialProvider({ path }).getCredentials(), next);
    // restrictPath performs a read-back verification of every Windows ACL entry.
    restrictPath(path);
    assert.deepEqual(readdirSync(directory), [basename(path)]);
  });

  it("fails closed on corrupt Windows ciphertext and preserves the original", { skip: process.platform !== "win32" }, async () => {
    const path = join(directory, "credentials.json");
    const original = JSON.stringify({ format: "quickbooks-mcp/dpapi", version: 1, ciphertext: "broken" });
    writeFileSync(path, original);
    const provider = new LocalCredentialProvider({ path });
    await assert.rejects(provider.getClientCredentials(), /Secure Windows storage failed/);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.deepEqual(readdirSync(directory), ["credentials.json"]);
  });

  it("migrates plaintext into Keychain before deleting the source, then updates that entry", async () => {
    const path = join(directory, "credentials.json");
    writeFileSync(path, JSON.stringify(fixture));
    const entry = fakeEntry();
    const calls: string[] = [];
    const provider = new LocalCredentialProvider({ path, platform: "darwin", keychain: async (service, account) => { assert.equal(service, "quickbooks-mcp"); calls.push(account); return entry; } });
    const [a, b] = await Promise.all([provider.getCredentials(), provider.getCredentials()]);
    assert.deepEqual(a, fixture); assert.deepEqual(b, fixture);
    assert.ok(!existsSync(path));
    assert.deepEqual(JSON.parse(entry.getPassword()!), fixture);
    await provider.saveCredentials({ ...fixture, access_token: "", refresh_token: "", company_id: undefined });
    assert.equal(await provider.isConfigured(), false);
    assert.equal((await provider.getClientCredentials())?.clientSecret, fixture.client_secret);
    assert.equal(new Set(calls).size, 1);
  });

  it("preserves plaintext when Keychain is denied or read-back verification fails", async () => {
    const path = join(directory, "credentials.json");
    const original = JSON.stringify(fixture);
    writeFileSync(path, original);
    const denied = new LocalCredentialProvider({ path, platform: "darwin", keychain: async () => { throw new Error("permission denied"); } });
    await assert.rejects(denied.getCredentials(), /plaintext fallback is disabled/);
    assert.equal(readFileSync(path, "utf8"), original);
    const broken = new LocalCredentialProvider({ path, platform: "darwin", keychain: async () => ({ getPassword: () => null, setPassword: () => {} }) });
    await assert.rejects(broken.getCredentials(), /save and verify/);
    assert.equal(readFileSync(path, "utf8"), original);
  });

  it("rejects a foreign encrypted file without attempting a plaintext fallback", async () => {
    const path = join(directory, "credentials.json");
    writeFileSync(path, JSON.stringify({ format: "quickbooks-mcp/dpapi", version: 1, ciphertext: "synthetic" }));
    const provider = new LocalCredentialProvider({ path, platform: "darwin", keychain: async () => fakeEntry() });
    await assert.rejects(provider.getCredentials(), /another platform/);
    assert.ok(existsSync(path));
  });

  it("writes owner-only POSIX files and leaves no temporary files", { skip: process.platform === "win32" }, async () => {
    const path = join(directory, "credentials.json");
    const provider = new LocalCredentialProvider({ path, platform: "linux" });
    await provider.saveCredentials(fixture);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(await provider.getCredentials(), fixture);
    assert.deepEqual(readdirSync(directory), ["credentials.json"]);
  });

  it("preserves an existing file when replacement cannot create a temporary file", () => {
    const path = join(directory, "credentials.json");
    writeFileSync(path, "original");
    assert.throws(() => privateAtomicWrite(join(path, "impossible.json"), "new-value"));
    assert.equal(readFileSync(path, "utf8"), "original");
    assert.deepEqual(readdirSync(directory), ["credentials.json"]);
  });

  it("round-trips an isolated entry through the native macOS Keychain", { skip: process.platform !== "darwin" }, async () => {
    const path = join(directory, "credentials.json");
    const provider = new LocalCredentialProvider({ path });
    const { Entry } = await import("@napi-rs/keyring");
    const account = createHash("sha256").update(join(realpathSync(dirname(path)), basename(path))).digest("hex");
    const entry = new Entry("quickbooks-mcp", account);
    try {
      await provider.saveCredentials(fixture);
      assert.deepEqual(await provider.getCredentials(), fixture);
      assert.ok(!existsSync(path));
    } finally { entry.deletePassword(); }
  });
});

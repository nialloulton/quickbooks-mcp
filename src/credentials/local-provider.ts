import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { CredentialProvider, QBCredentials } from "./types.js";
import { ensurePrivateDirectory, privateAtomicWrite, restrictPath, windowsSecureOperation } from "./secure-file.js";
import { registerSecrets } from "../utils/redact.js";

export interface KeychainEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
}
export type KeychainFactory = (service: string, account: string) => Promise<KeychainEntry>;
const keychainFactory: KeychainFactory = async (service, account) => {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(service, account);
  } catch {
    throw new Error("macOS Keychain is unavailable. Install optional dependencies and allow Keychain access for this account; plaintext fallback is disabled.");
  }
};

const queues = new Map<string, Promise<unknown>>();
function serialize<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  queues.set(path, current);
  void current.finally(() => { if (queues.get(path) === current) queues.delete(path); }).catch(() => {});
  return current;
}

function configuredPath(): string {
  const value = process.env.QBO_CREDENTIAL_FILE || join(homedir(), ".quickbooks-mcp", "credentials.json");
  return resolve(value === "~" ? homedir() : /^~[\\/]/.test(value) ? join(homedir(), value.slice(2)) : value);
}

function parseCredentials(text: string): Partial<QBCredentials> {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text); } catch { throw new Error("Credential data is invalid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || "format" in parsed) throw new Error("Unrecognized credential format. Authenticate separately on this computer.");
  const result: Partial<QBCredentials> = {};
  for (const key of ["client_id", "client_secret", "redirect_url", "access_token", "refresh_token", "company_id"] as const) {
    if (parsed[key] !== undefined && typeof parsed[key] !== "string") throw new Error("Credential fields must be strings.");
    if (typeof parsed[key] === "string") result[key] = parsed[key];
  }
  if (typeof parsed.access_token_expires_at === "number" && Number.isFinite(parsed.access_token_expires_at)) {
    result.access_token_expires_at = parsed.access_token_expires_at;
  }
  if (!result.client_id && !result.client_secret && !result.access_token && !result.refresh_token) throw new Error("Credential data has no recognized credentials.");
  registerSecrets(result.client_secret, result.access_token, result.refresh_token);
  return result;
}

export class LocalCredentialProvider implements CredentialProvider {
  readonly credentialPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly keychain: KeychainFactory;
  // Platform/factory injection lets CI test denial and migration without a real account.
  constructor(options: { path?: string; platform?: NodeJS.Platform; keychain?: KeychainFactory } = {}) {
    this.credentialPath = resolve(options.path || configuredPath());
    this.platform = options.platform || process.platform;
    this.keychain = options.keychain || keychainFactory;
  }

  get storageDescription(): string {
    return this.platform === "darwin" ? "macOS Keychain" : this.platform === "win32" ? "Windows user-encrypted credential file" : "owner-only credential file";
  }

  private prepare(): void {
    const parent = dirname(this.credentialPath);
    if (!existsSync(parent) || parent === join(homedir(), ".quickbooks-mcp")) ensurePrivateDirectory(parent);
    if (existsSync(this.credentialPath)) restrictPath(this.credentialPath);
  }

  private async entry(): Promise<KeychainEntry> {
    const canonical = join(realpathSync(dirname(this.credentialPath)), basename(this.credentialPath));
    const account = createHash("sha256").update(canonical).digest("hex");
    return this.keychain("quickbooks-mcp", account);
  }

  private async write(stored: Partial<QBCredentials>): Promise<void> {
    const plaintext = JSON.stringify(stored);
    parseCredentials(plaintext);
    this.prepare();
    if (this.platform === "darwin") {
      try {
        const entry = await this.entry();
        entry.setPassword(plaintext);
        if (entry.getPassword() !== plaintext) throw new Error("verification");
      } catch { throw new Error("Could not save and verify macOS Keychain credentials. Unlock your login Keychain and allow access; plaintext fallback is disabled."); }
      if (existsSync(this.credentialPath)) unlinkSync(this.credentialPath);
    } else if (this.platform === "win32") {
      const ciphertext = windowsSecureOperation("protect", Buffer.from(plaintext).toString("base64"));
      const verified = Buffer.from(windowsSecureOperation("unprotect", ciphertext), "base64").toString("utf8");
      if (verified !== plaintext) throw new Error("Encrypted credential verification failed.");
      privateAtomicWrite(this.credentialPath, JSON.stringify({ format: "quickbooks-mcp/dpapi", version: 1, ciphertext }));
    } else {
      privateAtomicWrite(this.credentialPath, plaintext);
    }
  }

  private async read(): Promise<Partial<QBCredentials> | null> {
    this.prepare();
    if (this.platform === "darwin") {
      let text: string | null;
      try { text = (await this.entry()).getPassword(); }
      catch { throw new Error("Could not read macOS Keychain. Unlock your login Keychain and allow access; plaintext fallback is disabled."); }
      if (text !== null) {
        const stored = parseCredentials(text);
        // A verified Keychain entry wins over a leftover file after an interrupted migration.
        if (existsSync(this.credentialPath)) unlinkSync(this.credentialPath);
        return stored;
      }
    }
    if (!existsSync(this.credentialPath)) return null;
    const text = readFileSync(this.credentialPath, "utf8");
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(text); } catch { throw new Error("Credential data is invalid JSON."); }
    if (envelope && typeof envelope === "object" && "format" in envelope) {
      if (this.platform !== "win32" || envelope.format !== "quickbooks-mcp/dpapi" || envelope.version !== 1 || typeof envelope.ciphertext !== "string") {
        throw new Error("Encrypted credentials belong to another platform or format. Authenticate separately on this computer.");
      }
      return parseCredentials(Buffer.from(windowsSecureOperation("unprotect", envelope.ciphertext), "base64").toString("utf8"));
    }
    const stored = parseCredentials(text);
    if (this.platform === "win32" || this.platform === "darwin") await this.write(stored);
    return stored;
  }

  async getCredentials(): Promise<QBCredentials> {
    return serialize(this.credentialPath, async () => {
      const stored = await this.read();
      if (!stored) throw new Error("Credentials are missing. Configure app credentials and run qbo_authenticate.");
      const credentials: QBCredentials = {
        client_id: process.env.QBO_CLIENT_ID || stored.client_id || "",
        client_secret: process.env.QBO_CLIENT_SECRET || stored.client_secret || "",
        redirect_url: stored.redirect_url || "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl",
        ...(stored.access_token_expires_at !== undefined && { access_token_expires_at: stored.access_token_expires_at }),
        access_token: stored.access_token || "", refresh_token: stored.refresh_token || "", company_id: stored.company_id,
      };
      registerSecrets(credentials.client_secret, credentials.access_token, credentials.refresh_token);
      return credentials;
    });
  }

  async saveCredentials(credentials: QBCredentials): Promise<void> {
    return serialize(this.credentialPath, () => this.write(credentials));
  }

  async getCompanyId(): Promise<string> {
    const value = (await this.getCredentials()).company_id;
    if (!value) throw new Error("Company ID missing. Run qbo_authenticate.");
    return value;
  }

  async isConfigured(): Promise<boolean> {
    return serialize(this.credentialPath, async () => {
      const c = await this.read();
      return !!(c && (process.env.QBO_CLIENT_ID || c.client_id) && (process.env.QBO_CLIENT_SECRET || c.client_secret) && c.access_token && c.refresh_token && c.company_id);
    });
  }

  async hasClientCredentials(): Promise<boolean> { return !!(await this.getClientCredentials()); }

  async getClientCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
    return serialize(this.credentialPath, async () => {
      const stored = await this.read();
      const clientId = process.env.QBO_CLIENT_ID || stored?.client_id;
      const clientSecret = process.env.QBO_CLIENT_SECRET || stored?.client_secret;
      registerSecrets(clientSecret);
      return clientId && clientSecret ? { clientId, clientSecret } : null;
    });
  }
}

import QuickBooks from "node-quickbooks";
import type { CredentialProvider, QBCredentials } from "../credentials/types.js";

const refreshMargin = 5 * 60_000;

export class ClientSession {
  private client?: QuickBooks;
  private expiresAt = 0;
  private pending?: Promise<QuickBooks>;
  // A 401 overrides even a future stored expiry for the rejected token.
  private rejectedToken?: string;
  private generation = 0;

  constructor(
    private readonly provider: () => CredentialProvider,
    private readonly refresh: (stored: QBCredentials) => Promise<QBCredentials>,
    private readonly now = Date.now,
  ) {}

  get companyId() { return this.client?.realmId ?? null; }

  clear() {
    this.generation++;
    this.client = undefined;
    this.expiresAt = 0;
    this.rejectedToken = undefined;
  }

  reject(client?: QuickBooks) {
    if (client && this.client === client) {
      this.rejectedToken = client.token;
      this.client = undefined;
      this.expiresAt = 0;
    }
  }

  async get(): Promise<QuickBooks> {
    if (this.client && this.expiresAt > this.now() + refreshMargin) return this.client;
    if (this.pending) return this.pending;
    const pending = this.initialise(this.generation);
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = undefined; }
  }

  private async initialise(generation: number): Promise<QuickBooks> {
    const provider = this.provider();
    if (!await provider.isConfigured()) throw new Error("QuickBooks credentials not configured. Check the credential provider or run qbo_authenticate in local mode.");
    let credentials = await provider.getCredentials();
    const realm = await provider.getCompanyId();
    if (!credentials.access_token || credentials.access_token === this.rejectedToken ||
        (credentials.access_token_expires_at ?? 0) <= this.now() + refreshMargin) {
      credentials = await this.refresh(credentials);
      this.checkGeneration(generation);
      await provider.saveCredentials(credentials);
    }
    this.checkGeneration(generation);
    this.client = new QuickBooks(credentials.client_id, credentials.client_secret, credentials.access_token, false,
      realm, process.env.QBO_SANDBOX === "true", false, null, "2.0", credentials.refresh_token);
    this.expiresAt = credentials.access_token_expires_at ?? 0;
    this.rejectedToken = undefined;
    return this.client;
  }

  private checkGeneration(generation: number) {
    if (generation !== this.generation) throw new Error("QuickBooks connection changed while acquiring a token. Retry on the current connection.");
  }
}

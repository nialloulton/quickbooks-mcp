import { randomBytes, timingSafeEqual } from "node:crypto";
import type { QBCredentials } from "./types.js";
import { registerSecrets } from "../utils/redact.js";

export const PLAYGROUND_REDIRECT_URL = "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl";
const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const SCOPE = "com.intuit.quickbooks.accounting";
const FLOW_TTL = 10 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

function environment(): string { return process.env.QBO_SANDBOX === "true" ? "sandbox" : "production"; }

/** One instance per MCP process. No network access is possible until state passes. */
export class OAuthFlow {
  private pending?: { state: string; clientId: string; environment: string; expires: number };
  constructor(private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  begin(clientId: string, clientSecret: string): string {
    registerSecrets(clientSecret);
    const state = randomBytes(32).toString("base64url");
    this.pending = { state, clientId, environment: environment(), expires: this.now() + FLOW_TTL };
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({ client_id: clientId, response_type: "code", scope: SCOPE, redirect_uri: PLAYGROUND_REDIRECT_URL, state }).toString();
    return url.toString();
  }

  clear(): void { this.pending = undefined; }

  async exchange(clientId: string, clientSecret: string, callbackUrl: string): Promise<TokenExchangeResult> {
    const pending = this.pending;
    if (!pending || pending.expires <= this.now() || pending.clientId !== clientId || pending.environment !== environment()) {
      this.clear();
      throw new Error("No matching unexpired sign-in. Run qbo_authenticate without arguments to start again.");
    }
    let url: URL;
    try { url = new URL(callbackUrl); } catch { throw new Error("Invalid callback URL. Paste the complete Intuit redirect URL."); }
    const expected = new URL(PLAYGROUND_REDIRECT_URL);
    if (callbackUrl.length > 16384 || url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) {
      throw new Error("Unexpected OAuth callback address.");
    }
    const fields = ["code", "realmId", "state"] as const;
    for (const key of fields) if (url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)?.trim()) throw new Error("Callback requires one code, realmId, and state value.");
    if (url.searchParams.has("error")) throw new Error("Intuit did not authorize this connection. Start sign-in again.");
    const state = url.searchParams.get("state")!;
    if (Buffer.byteLength(state) !== Buffer.byteLength(pending.state) || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) throw new Error("OAuth state mismatch. Use the redirect from the current sign-in.");
    const code = url.searchParams.get("code")!;
    const realmId = url.searchParams.get("realmId")!;
    if (!/^\d+$/.test(realmId)) throw new Error("Invalid company ID in callback.");
    this.clear(); // Consume synchronously, before await: replay/concurrent submissions cannot post twice.
    registerSecrets(code, state, clientSecret);
    const token = await tokenRequest(this.request, clientId, clientSecret, { grant_type: "authorization_code", code, redirect_uri: PLAYGROUND_REDIRECT_URL });
    return { companyId: realmId, credentials: { client_id: clientId, client_secret: clientSecret, redirect_url: PLAYGROUND_REDIRECT_URL, company_id: realmId, ...token } };
  }
}

export interface TokenExchangeResult { credentials: QBCredentials; companyId: string }

async function readBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_BODY_BYTES) {
        // Cancellation can itself remain pending for a shared/teed stream.
        void reader.cancel().catch(() => {});
        throw new Error("OAuth response exceeded size limit.");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

async function oauthRequest(request: typeof fetch, url: string, clientId: string, clientSecret: string, body: string, contentType: string): Promise<Record<string, unknown>> {
  registerSecrets(clientSecret);
  let response: Response;
  let text: string;
  try {
    response = await request(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"), "Content-Type": contentType, Accept: "application/json" }, body,
    });
    text = await readBody(response);
  } catch { throw new Error("OAuth request failed or timed out. Start sign-in again if exchanging a code."); }
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { throw new Error("Intuit returned an invalid OAuth response."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Intuit returned an invalid OAuth response.");
  if (!response.ok) {
    const known = new Set(["invalid_grant", "invalid_client", "invalid_request", "unauthorized_client", "unsupported_grant_type"]);
    const code = typeof parsed.error === "string" && known.has(parsed.error) ? parsed.error : "oauth_request_failed";
    throw Object.assign(new Error("Intuit OAuth error: " + code + ". Recheck app credentials or authenticate again."), { status: response.status, code });
  }
  return parsed;
}

async function tokenRequest(request: typeof fetch, clientId: string, clientSecret: string, fields: Record<string, string>): Promise<Pick<QBCredentials, "access_token" | "refresh_token" | "access_token_expires_at">> {
  const token = await oauthRequest(request, TOKEN_URL, clientId, clientSecret, new URLSearchParams(fields).toString(), "application/x-www-form-urlencoded");
  if (typeof token.access_token !== "string" || !token.access_token || typeof token.refresh_token !== "string" || !token.refresh_token || (token.token_type !== undefined && String(token.token_type).toLowerCase() !== "bearer")) throw new Error("Intuit returned an incomplete OAuth token response.");
  registerSecrets(token.access_token, token.refresh_token);
  const ttl = token.expires_in;
  return { access_token: token.access_token, refresh_token: token.refresh_token,
    ...(typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 && { access_token_expires_at: Date.now() + ttl * 1000 }) };
}

const flow = new OAuthFlow();
export function generateAuthorizationUrl(clientId: string, clientSecret: string): string { return flow.begin(clientId, clientSecret); }
export function clearPendingAuthorization(): void { flow.clear(); }
export function exchangeCodeForTokens(clientId: string, clientSecret: string, callbackUrl: string): Promise<TokenExchangeResult> { return flow.exchange(clientId, clientSecret, callbackUrl); }
export async function refreshAccessToken(credentials: QBCredentials, request: typeof fetch = fetch): Promise<QBCredentials> {
  registerSecrets(credentials.access_token, credentials.refresh_token);
  const token = await tokenRequest(request, credentials.client_id, credentials.client_secret, { grant_type: "refresh_token", refresh_token: credentials.refresh_token });
  const { access_token_expires_at: _oldExpiry, ...previous } = credentials;
  return { ...previous, ...token };
}
export async function revokeToken(clientId: string, clientSecret: string, token: string, request: typeof fetch = fetch): Promise<void> {
  registerSecrets(token);
  await oauthRequest(request, REVOKE_URL, clientId, clientSecret, JSON.stringify({ token }), "application/json");
}
export function getOAuthInstructions(authUrl: string): string {
  return "QuickBooks sign-in (" + environment() + ")\n\nOpen this link and authorize your company:\n" + authUrl + "\n\nPaste the complete redirect URL into qbo_authenticate as callback_url. It must include code, realmId, and state. This sign-in expires in ten minutes; restarting the server requires a new sign-in. Treat the callback URL as a temporary secret.";
}

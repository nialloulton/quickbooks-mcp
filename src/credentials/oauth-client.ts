// OAuth client wrapper for QuickBooks authentication

import OAuthClient from "intuit-oauth";
import type { QBCredentials } from "./types.js";

// Intuit's OAuth Playground redirect URL - works for both sandbox and production
const PLAYGROUND_REDIRECT_URL = "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl";

// Required scopes for QuickBooks Online accounting access
const REQUIRED_SCOPES = [OAuthClient.scopes.Accounting];

// Intuit discovery document URLs
const DISCOVERY_URLS = {
  production: "https://developer.api.intuit.com/.well-known/openid-configuration",
  sandbox: "https://sandbox-accounts.platform.intuit.com/.well-known/openid-configuration",
};

// Fallback revocation endpoints (used if discovery document is unavailable)
const FALLBACK_REVOKE_URLS = {
  production: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
  sandbox: "https://sandbox-accounts.platform.intuit.com/v2/oauth2/tokens/revoke",
};

// Cached discovery document
let discoveryCache: { environment: string; document: DiscoveryDocument; fetchedAt: number } | null = null;
const DISCOVERY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  userinfo_endpoint?: string;
  issuer?: string;
}

/**
 * Fetch the Intuit OpenID Connect discovery document.
 * Caches for 24 hours per session.
 */
export async function getDiscoveryDocument(): Promise<DiscoveryDocument | null> {
  const env = getEnvironment();

  // Return cached if still valid
  if (discoveryCache && discoveryCache.environment === env &&
      Date.now() - discoveryCache.fetchedAt < DISCOVERY_CACHE_TTL) {
    return discoveryCache.document;
  }

  try {
    const response = await fetch(DISCOVERY_URLS[env]);
    if (!response.ok) return null;
    const doc = await response.json() as DiscoveryDocument;
    discoveryCache = { environment: env, document: doc, fetchedAt: Date.now() };
    return doc;
  } catch {
    return null;
  }
}

/**
 * Get the token revocation endpoint from the discovery document,
 * falling back to the known endpoint if discovery fails.
 */
export async function getRevocationEndpoint(): Promise<string> {
  const doc = await getDiscoveryDocument();
  if (doc?.revocation_endpoint) return doc.revocation_endpoint;
  return FALLBACK_REVOKE_URLS[getEnvironment()];
}

/**
 * Revoke an OAuth token (access or refresh token).
 * Uses the revocation endpoint from the discovery document.
 */
export async function revokeToken(
  clientId: string,
  clientSecret: string,
  token: string,
): Promise<void> {
  const endpoint = await getRevocationEndpoint();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${basicAuth}`,
      'Accept': 'application/json',
    },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token revocation failed (${response.status}): ${body}`);
  }
}

/**
 * Get the environment setting (sandbox or production)
 */
function getEnvironment(): "sandbox" | "production" {
  return process.env.QBO_SANDBOX === "true" ? "sandbox" : "production";
}

/**
 * Create an OAuth client instance with client credentials
 */
export function createOAuthClient(clientId: string, clientSecret: string): OAuthClient {
  return new OAuthClient({
    clientId,
    clientSecret,
    environment: getEnvironment(),
    redirectUri: PLAYGROUND_REDIRECT_URL,
  });
}

/**
 * Generate the authorization URL for OAuth flow
 * User visits this URL to authorize the app
 */
export function generateAuthorizationUrl(clientId: string, clientSecret: string): string {
  const oauthClient = createOAuthClient(clientId, clientSecret);
  return oauthClient.authorizeUri({
    scope: REQUIRED_SCOPES,
  });
}

/**
 * Result of exchanging an authorization code for tokens
 */
export interface TokenExchangeResult {
  credentials: QBCredentials;
  companyId: string;
}

/**
 * Exchange authorization code for access and refresh tokens
 */
export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  authorizationCode: string,
  realmId: string
): Promise<TokenExchangeResult> {
  const oauthClient = createOAuthClient(clientId, clientSecret);

  // Build the callback URL format that intuit-oauth expects
  const callbackUrl = `${PLAYGROUND_REDIRECT_URL}?code=${encodeURIComponent(authorizationCode)}&realmId=${encodeURIComponent(realmId)}`;

  // Exchange code for tokens
  const authResponse = await oauthClient.createToken(callbackUrl);
  const token = authResponse.getToken();

  const credentials: QBCredentials = {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_url: PLAYGROUND_REDIRECT_URL,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    company_id: realmId,
  };

  return {
    credentials,
    companyId: realmId,
  };
}

/**
 * Refresh access token using a refresh token
 */
export async function refreshAccessToken(credentials: QBCredentials): Promise<QBCredentials> {
  const oauthClient = createOAuthClient(credentials.client_id, credentials.client_secret);

  // Set the current refresh token
  oauthClient.setToken({
    refresh_token: credentials.refresh_token,
    access_token: credentials.access_token,
  });

  // Refresh the token
  const authResponse = await oauthClient.refresh();
  const token = authResponse.getToken();

  return {
    ...credentials,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
  };
}

/**
 * Get instructions for the OAuth flow
 */
export function getOAuthInstructions(authUrl: string): string {
  const environment = getEnvironment();
  return `
## QuickBooks OAuth Setup

**Environment:** ${environment}

### Step 1: Authorize the Application

1. Open this URL in your browser:
   ${authUrl}

2. Sign in to your Intuit/QuickBooks account

3. Select the company you want to connect

4. Click "Connect" to authorize

### Step 2: Get the Authorization Code

After authorizing, you'll be redirected to the OAuth Playground.
The URL will contain two important values:

- **code**: The authorization code (a long string)
- **realmId**: Your company/realm ID (a number like 9130350484847232)

Example URL:
\`https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl?code=AB11...&realmId=9130350484847232\`

### Step 3: Complete Authentication

Call this tool again with:
- authorization_code: The "code" value from the URL
- realm_id: The "realmId" value from the URL

Example:
\`\`\`json
{
  "authorization_code": "AB11...",
  "realm_id": "9130350484847232"
}
\`\`\`
`.trim();
}

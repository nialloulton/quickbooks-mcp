import { isLocalMode } from "../../credentials/index.js";
import { LocalCredentialProvider } from "../../credentials/local-provider.js";
import { generateAuthorizationUrl, exchangeCodeForTokens, getOAuthInstructions } from "../../credentials/oauth-client.js";
import { clearCredentialsCache } from "../../client/auth.js";
import { formatQboError } from "../../utils/errors.js";

export async function handleAuthenticate(args: { callback_url?: string }) {
  if (!isLocalMode()) return { content: [{ type: "text", text: "qbo_authenticate only works in local credential mode. AWS uses Secrets Manager." }], isError: true };
  try {
    const provider = new LocalCredentialProvider();
    const client = await provider.getClientCredentials();
    if (!client) return { content: [{ type: "text", text: "Configure QBO_CLIENT_ID and QBO_CLIENT_SECRET in your local environment, or bootstrap " + provider.credentialPath + " with client_id and client_secret. On Windows and Mac, an existing plaintext file is migrated to protected storage before use. Never paste app secrets into chat." }], isError: true };
    if (args.callback_url !== undefined) {
      const result = await exchangeCodeForTokens(client.clientId, client.clientSecret, args.callback_url);
      await provider.saveCredentials(result.credentials);
      clearCredentialsCache();
      return { content: [{ type: "text", text: "Connected to QuickBooks company " + result.companyId + ". Credentials saved in " + provider.storageDescription + ". Use get_company_info to verify the connection." }] };
    }
    return { content: [{ type: "text", text: getOAuthInstructions(generateAuthorizationUrl(client.clientId, client.clientSecret)) }] };
  } catch (error) {
    return { content: [{ type: "text", text: "Authentication failed: " + formatQboError(error) }], isError: true };
  }
}

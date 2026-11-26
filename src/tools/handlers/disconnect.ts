// Handler for qbo_disconnect tool - revoke tokens and clear credentials

import { isLocalMode, getCredentialMode } from "../../credentials/index.js";
import { LocalCredentialProvider } from "../../credentials/local-provider.js";
import { revokeToken, clearPendingAuthorization } from "../../credentials/oauth-client.js";
import { clearCredentialsCache } from "../../client/index.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/**
 * Handle the qbo_disconnect tool
 * Revokes the OAuth token with Intuit and clears local credentials
 */
export async function handleDisconnect(): Promise<ToolResult> {
  // Check if we're in local mode
  if (!isLocalMode()) {
    return {
      content: [{
        type: "text",
        text: `The qbo_disconnect tool only works in local credential mode.\n\n` +
          `Current mode: ${getCredentialMode()}\n\n` +
          `For AWS mode, remove credentials from AWS Secrets Manager directly.`,
      }],
      isError: true,
    };
  }

  clearPendingAuthorization();
  clearCredentialsCache();
  const localProvider = new LocalCredentialProvider();

  // Check if we have credentials to revoke
  const isConfigured = await localProvider.isConfigured();
  if (!isConfigured) {
    return {
      content: [{
        type: "text",
        text: `No QuickBooks connection found. There are no credentials to disconnect.`,
      }],
    };
  }

  const credentials = await localProvider.getCredentials();

  // Attempt to revoke the token with Intuit
  let revoked = false;
  try {
    await revokeToken(
      credentials.client_id,
      credentials.client_secret,
      credentials.refresh_token,
    );
    revoked = true;
  } catch (error) {
    // Token revocation is best-effort - the token may already be expired/invalid
    // We still clear local credentials regardless
  }

  // Clear in-memory cache
  clearCredentialsCache();

  // Clear local credentials file (keep client_id and client_secret for re-auth)
  try {
    await localProvider.saveCredentials({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      redirect_url: credentials.redirect_url,
      access_token: "",
      refresh_token: "",
    });
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Warning: Token was ${revoked ? 'revoked' : 'not revoked'} with Intuit, ` +
          `but failed to clear local credentials file.\n\n` +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text",
      text: `## Disconnected from QuickBooks\n\n` +
        (revoked
          ? `OAuth token has been revoked with Intuit.\n`
          : `Note: Could not revoke token with Intuit (it may already be expired).\n`) +
        `Local credentials have been cleared.\n\n` +
        `To reconnect, run the \`qbo_authenticate\` tool.`,
    }],
  };
}

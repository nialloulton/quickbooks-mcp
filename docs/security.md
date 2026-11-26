# Security and desktop setup

Use Node.js 22 or later. Install with `npm ci` and build with `npm run build`.
The local MCP uses stdio; it does not open an HTTP listener. Connecting the MCP
client is separate from authorizing access to QuickBooks through Intuit.

## Local credentials

`QBO_CREDENTIAL_MODE=local` selects the operating system's storage automatically:

| Platform | Storage |
| --- | --- |
| Windows | DPAPI CurrentUser encrypted envelope at the configured credential path; explicit ACL for the current user, SYSTEM, and Administrators |
| macOS | Login Keychain entry through the optional `@napi-rs/keyring` dependency; service `quickbooks-mcp`, account derived from the canonical credential path |
| Linux | JSON file with verified mode 0600; the default credential directory uses 0700 |
| AWS mode | Existing Secrets Manager provider; desktop encryption modules are not loaded |

The default profile is `~/.quickbooks-mcp/credentials.json`; `QBO_CREDENTIAL_FILE`
selects another profile. On Mac, that path identifies the Keychain entry even
after the plaintext file has been removed. Do not move or rename a Mac profile
path without reconfiguring its credentials. Authenticate separately on each
computer; Windows encrypted files cannot be decrypted on a Mac or under another
Windows account. This is protection at rest, not protection from malicious
software running as your own user or from an administrator controlling the host.

Bootstrap with `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` in the server's local
environment, or an existing JSON file containing `client_id` and `client_secret`.
Never supply these secrets as MCP tool arguments or commit them. On Windows and
Mac, plaintext files are migrated before use; verify the protected copy before
removing/replacing the source. No plaintext backup is created. Migration failure
leaves the original available for recovery, with restricted access when possible,
and stops the operation instead of falling back to plaintext. Environment
variables supplied by your MCP client remain that client's responsibility.

After building, run `npm run security:migrate` once to migrate credentials and
sanitize existing logs without contacting QuickBooks. This prints only status.
On macOS, install optional dependencies and allow access to the login Keychain.
If it is locked, access is denied, or the native binding is unavailable, unlock
or repair the Keychain setup; there is no automatic plaintext fallback.

Windows migration requires the owning Windows user. Removing access for other
local accounts, including sandbox users, means a server launched under one of
those accounts cannot read these credentials. Launch the MCP under the owning
account. Do not solve this by sharing the secret file with every local user.

## Sign-in

Register this exact redirect URI with your Intuit app:

```
https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl
```

Call `qbo_authenticate` without arguments, open the returned authorization URL,
then pass the complete redirect URL as `callback_url`. The former
`authorization_code`/`realm_id` argument pair is rejected. A pending sign-in is
single-use, expires after ten minutes, and is bound to the initiating app and
environment. Starting another sign-in or restarting the server invalidates it.
Treat the callback URL as a temporary secret: it contains the authorization code.
The MCP client may retain tool arguments in its own history; server log sanitizing
does not control that history.

The server validates state before making a token request. OAuth HTTP requests
have time and size limits and reject redirects. A failed or ambiguous exchange
requires starting again. The server reuses a valid access token until five minutes before its expiry and preserves its expiry in protected storage across restarts. Older profiles refresh once to obtain the expiry. Concurrent calls in one process share a refresh. Separate server processes should
not share one live credential profile because refresh-token rotation is not
coordinated between processes.

`qbo_disconnect` revokes the token and clears locally stored tokens while retaining
the app's client credentials. If revocation fails, its response says so; local
deletion cannot guarantee that Intuit has revoked a token.

Both sign-in and disconnect tools are unavailable remotely. Lambda continues to
require its configured authentication and enforce the remote tool allowlist.

## Diagnostics and verification

Logs contain only timestamps, tool names, outcomes, HTTP status, fault codes, and
Intuit request IDs. Historical structured logs are rewritten to those fields;
unstructured entries are discarded. No backup of discarded raw payloads is kept.
Request IDs are isolated between tool calls. Error responses redact registered
credentials, authorization headers, callback URLs, and common secret fields.
Normal accounting tool results still contain the data the caller requested.

`QBO_LOG_DIR` overrides the default `~/.quickbooks-mcp/logs` directory. Use a
dedicated directory because its permissions are restricted. Rotated files receive
the same protection. Log failures never cause an accounting operation to replay.

Run `npm test`, both build scripts, `node scripts/smoke-mcp.mjs`, and `npm audit`.
CI covers Windows, Linux, Apple Silicon Mac, and Intel Mac with synthetic fixtures.
Native Mac tests need a working Keychain; passing mocked tests on Windows alone
does not establish Mac compatibility.

import QuickBooks from "node-quickbooks";
import { isRefreshTokenError, isInvalidGrantError } from "../types/index.js";
import { getCredentialProvider } from "../credentials/index.js";
import { refreshAccessToken } from "../credentials/oauth-client.js";
import { clearLookupCache } from "./cache.js";
import { ClientSession } from "./session.js";

const session = new ClientSession(getCredentialProvider, refreshAccessToken);
export function getCompanyIdValue(): string | null { return session.companyId; }
export function getClient(): Promise<QuickBooks> { return session.get(); }
export function rejectClient(client?: QuickBooks): void { session.reject(client); }
export function clearCredentialsCache(): void { session.clear(); clearLookupCache(); }
export { isAuthFault as isAuthError } from "../utils/errors.js";
export function isReauthRequired(error: unknown): boolean { return isRefreshTokenError(error) || isInvalidGrantError(error); }
export { isCSRFError } from "../types/index.js";

// Local-only migration. Does not connect to Intuit or print credential values.
import { LocalCredentialProvider } from "../dist/credentials/local-provider.js";
import { migrateLogs } from "../dist/utils/logger.js";

try {
  const provider = new LocalCredentialProvider();
  const configured = await provider.hasClientCredentials();
  migrateLogs();
  console.log(configured
    ? `Credentials verified in ${provider.storageDescription}; diagnostic logs sanitized.`
    : "No app credentials found; diagnostic logs sanitized.");
} catch {
  console.error("Security migration did not complete. Check the owning OS account, secure-storage availability, and file permissions. No plaintext fallback was used.");
  process.exitCode = 1;
}

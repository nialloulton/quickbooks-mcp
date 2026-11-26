import { it } from "node:test";
import assert from "node:assert/strict";
import { ClientSession } from "../../src/client/session.js";
import type { QBCredentials } from "../../src/credentials/types.js";

it("reuses encrypted-profile or in-memory access tokens, including after a restart; refreshes once near expiry or on rejection", async () => {
  let now = 1_000_000;
  let stored: QBCredentials = { client_id: "app", client_secret: "secret", redirect_url: "", company_id: "123", access_token: "legacy", refresh_token: "refresh" };
  let refreshes = 0;
  const provider = {
    getCredentials: async () => ({ ...stored }), getCompanyId: async () => "123", isConfigured: async () => true,
    saveCredentials: async (c: QBCredentials) => { stored = c; },
  };
  const make = () => new ClientSession(() => provider, async (c) => ({
    ...c, access_token: `token-${++refreshes}`, access_token_expires_at: now + 3600_000,
  }), () => now);
  const session = make();
  const [one,two] = await Promise.all([session.get(), session.get()]);
  assert.equal(one, two);
  assert.equal(await session.get(), one);
  assert.equal((await make().get()).token, one.token);
  assert.equal(refreshes, 1);
  now += 55 * 60_000;
  const nearExpiry = await session.get();
  assert.equal(refreshes, 2);
  session.reject(one);
  assert.equal(await session.get(), nearExpiry);
  session.reject(nearExpiry);
  await Promise.all([session.get(),session.get()]);
  assert.equal(refreshes, 3);
});

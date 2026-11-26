import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OAuthFlow, PLAYGROUND_REDIRECT_URL, refreshAccessToken, revokeToken } from "../../src/credentials/oauth-client.js";
import { executeTool } from "../../src/tools/index.js";

const credentials = { client_id: "example-client", client_secret: "example-client-secret", redirect_url: PLAYGROUND_REDIRECT_URL, access_token: "old-access", refresh_token: "old-refresh", company_id: "123" };
function mockTransport(response = new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", token_type: "bearer" }))) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const request = (async (url, init) => { calls.push({ url: String(url), init }); return response.clone(); }) as typeof fetch;
  return { calls, request };
}
function callback(flow: OAuthFlow): URL {
  const start = new URL(flow.begin(credentials.client_id, credentials.client_secret));
  const url = new URL(PLAYGROUND_REDIRECT_URL);
  url.search = new URLSearchParams({ code: "example-authorization-code", realmId: "123", state: start.searchParams.get("state")! }).toString();
  return url;
}

it("records Intuit's access-token lifetime and discards stale expiry when a refresh omits it", async () => {
  const before = Date.now();
  const reply = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 };
  const refreshed = await refreshAccessToken(credentials, mockTransport(Response.json(reply)).request);
  assert.ok(refreshed.access_token_expires_at! >= before + 3_600_000);
  assert.ok(refreshed.access_token_expires_at! <= Date.now() + 3_600_000);
  const noLifetime = await refreshAccessToken(refreshed, mockTransport().request);
  assert.equal(noLifetime.access_token_expires_at, undefined);
});

describe("OAuth state validation", () => {
  it("exchanges a valid callback once, using a bounded fixed HTTPS endpoint", async () => {
    const { calls, request } = mockTransport();
    const flow = new OAuthFlow(request);
    const url = callback(flow).toString();
    const result = await flow.exchange(credentials.client_id, credentials.client_secret, url);
    assert.equal(result.companyId, "123");
    assert.equal(result.credentials.refresh_token, "new-refresh");
    assert.equal(calls[0].url, "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
    assert.equal(calls[0].init?.redirect, "error");
    assert.ok(calls[0].init?.signal);
    assert.equal(new URLSearchParams(calls[0].init?.body as string).get("redirect_uri"), PLAYGROUND_REDIRECT_URL);
    await assert.rejects(flow.exchange(credentials.client_id, credentials.client_secret, url), /No matching/);
    assert.equal(calls.length, 1);
  });

  it("rejects malformed, ambiguous, and substituted callbacks before any network call", async () => {
    const mutations: Array<(u: URL) => void> = [
      u => { u.hostname = "attacker.example"; }, u => { u.protocol = "http:"; },
      u => { u.pathname += "/extra"; }, u => { u.username = "injected"; }, u => { u.hash = "fragment"; },
      u => { u.searchParams.delete("state"); }, u => { u.searchParams.set("state", "mismatch"); },
      u => { u.searchParams.set("state", "x".repeat(43)); },
      u => { u.searchParams.append("state", u.searchParams.get("state")!); },
      u => { u.searchParams.append("code", "second"); }, u => { u.searchParams.set("code", " "); },
      u => { u.searchParams.delete("realmId"); }, u => { u.searchParams.set("realmId", "not-a-company"); },
      u => { u.searchParams.append("realmId", "456"); }, u => { u.searchParams.set("error", "access_denied"); },
    ];
    for (const mutate of mutations) {
      const { calls, request } = mockTransport();
      const flow = new OAuthFlow(request);
      const url = callback(flow); mutate(url);
      await assert.rejects(flow.exchange(credentials.client_id, credentials.client_secret, url.toString()));
      assert.equal(calls.length, 0);
    }
  });

  it("expires flows and binds them to the initiating client and environment", async () => {
    let now = 0;
    const { calls, request } = mockTransport();
    const flow = new OAuthFlow(request, () => now);
    const url = callback(flow).toString();
    now = 600_000;
    await assert.rejects(flow.exchange(credentials.client_id, credentials.client_secret, url), /No matching/);
    const next = callback(flow).toString();
    await assert.rejects(flow.exchange("another-client", credentials.client_secret, next), /No matching/);
    const oldEnvironment = process.env.QBO_SANDBOX;
    try {
      process.env.QBO_SANDBOX = "false";
      const production = callback(flow).toString();
      process.env.QBO_SANDBOX = "true";
      await assert.rejects(flow.exchange(credentials.client_id, credentials.client_secret, production), /No matching/);
    } finally { if (oldEnvironment === undefined) delete process.env.QBO_SANDBOX; else process.env.QBO_SANDBOX = oldEnvironment; }
    assert.equal(calls.length, 0);
  });

  it("invalidates an earlier flow and prevents concurrent submission", async () => {
    const { calls, request } = mockTransport();
    const flow = new OAuthFlow(request);
    const old = callback(flow).toString();
    const current = callback(flow).toString();
    await assert.rejects(flow.exchange(credentials.client_id, credentials.client_secret, old), /state mismatch/);
    const results = await Promise.allSettled([flow.exchange(credentials.client_id, credentials.client_secret, current), flow.exchange(credentials.client_id, credentials.client_secret, current)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(calls.length, 1);
  });

  it("does not retry ambiguous failures, or disclose provider response bodies", async () => {
    for (const response of [new Response("provider-secret".repeat(6000)), new Response("provider-secret", { status: 500 }), new Response(JSON.stringify({ error: "invalid_grant", error_description: "provider-secret" }), { status: 400 }), new Response("{}"), new Response("[]")]) {
      const { calls, request } = mockTransport(response);
      const flow = new OAuthFlow(request);
      const url = callback(flow).toString();
      await assert.rejects(flow.exchange(credentials.client_id, credentials.client_secret, url), e => !String(e).includes("provider-secret"));
      await assert.rejects(flow.exchange(credentials.client_id, credentials.client_secret, url));
      assert.equal(calls.length, 1);
    }
    const flow = new OAuthFlow((async () => { throw new DOMException("secret-url", "TimeoutError"); }) as typeof fetch);
    await assert.rejects(flow.exchange(credentials.client_id, credentials.client_secret, callback(flow).toString()), /failed or timed out/);
  });

  it("rejects the former code/company-only tool interface", async () => {
    const result = await executeTool("qbo_authenticate", { authorization_code: "unused-code", realm_id: "123" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid arguments/);
  });

  it("refreshes and revokes with the same safe transport", async () => {
    const { calls, request } = mockTransport();
    assert.equal((await refreshAccessToken(credentials, request)).access_token, "new-access");
    assert.equal(new URLSearchParams(calls[0].init?.body as string).get("grant_type"), "refresh_token");
    const revocation = mockTransport(new Response(""));
    await revokeToken(credentials.client_id, credentials.client_secret, credentials.refresh_token, revocation.request);
    assert.equal(revocation.calls[0].url, "https://developer.api.intuit.com/v2/oauth2/tokens/revoke");
    assert.equal(revocation.calls[0].init?.redirect, "error");
  });
});

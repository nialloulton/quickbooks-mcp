import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import QuickBooks from "node-quickbooks";

const require = createRequire(import.meta.url);
const clientRequire = createRequire(require.resolve("node-quickbooks"));

describe("patched QuickBooks dependencies", () => {
  it("preserves the XMLParser API used by the QuickBooks client", () => {
    const { XMLParser } = clientRequire("fast-xml-parser");
    assert.deepEqual(new XMLParser().parse("<Response><ErrorCode>0</ErrorCode><Message>ok</Message></Response>"), { Response: { ErrorCode: 0, Message: "ok" } });
  });

  it("executes a client query with patched underscore, Axios, and UUID using an offline adapter", async () => {
    const axios = clientRequire("axios");
    const original = axios.defaults.adapter;
    const requests: Array<Record<string, any>> = [];
    axios.defaults.adapter = async (config: Record<string, any>) => {
      requests.push(config);
      return { data: { QueryResponse: { Account: [{ Id: "1", Name: "Fixture account" }], startPosition: 1, maxResults: 1 } }, status: 200, statusText: "OK", headers: {}, config };
    };
    try {
      const client = new QuickBooks("fixture-client", "fixture-secret", "fixture-token", false, "123", true, false, null, "2.0", "fixture-refresh");
      const result = await new Promise<any>((resolve, reject) => client.findAccounts([{ field: "Active", value: true }], (error: unknown, value: unknown) => error ? reject(error) : resolve(value)));
      assert.equal(result.QueryResponse.Account[0].Id, "1");
      assert.equal(requests.length, 1);
      assert.match(requests[0].headers["Request-Id"], /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.match(new URL(requests[0].url).searchParams.get("query")!, /Active/);
    } finally { axios.defaults.adapter = original; }
  });
});

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type QuickBooks from "node-quickbooks";
import { server } from "../../src/server.js";
import { ClientSession } from "../../src/client/session.js";
import { clearLookupCache } from "../../src/client/cache.js";
import { setOutputMode } from "../../src/utils/output.js";

// The only company available to the dispatcher in this suite is an in-memory
// fixture. Unknown SDK methods or REST paths fail rather than going to Intuit.
const client = new Client({ name: "fictional-finance-evaluation", version: "1" });
const purchase = { Id: "71", TotalAmt: 48, TxnDate: "2025-04-04", CurrencyRef: { value: "GBP" } };
const oldRef = { EntityRef: { type: "Invoice", value: "71" }, IncludeOnSend: true, LineInfo: { LineId: "5" } };
const newRef = { EntityRef: { type: "Purchase", value: "71" }, IncludeOnSend: false };
const fictionalPdf = Buffer.from("%PDF-1.4\nFictional supporting document\n%%EOF");
const attachment = () => ({ Id: "81", FileName: "fictional-rail.pdf", ContentType: "application/pdf",
  SyncToken: "2", AttachableRef: [oldRef] as Array<{ EntityRef: { type: string; value: string }; IncludeOnSend?: boolean }> });
type Callback = (error: unknown, result: unknown) => void;
const rows = (entity: string, records: unknown[]) => (_criteria: unknown, cb: Callback) =>
  cb(null, { QueryResponse: { [entity]: records } });
const lines = (group: string, amount: number) => ({
  type: "Section", group, Summary: { ColData: [{ value: group }, { value: amount.toFixed(2) }] },
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ text: string }>;
  return { error: result.isError === true, text: content.map(part => part.text).join("\n"), content };
}

describe("fictional finance workflows v1 through MCP", () => {
  let file = attachment();
  let writes: string[];
  let rejectRevision: boolean;
  let discardUpdate: boolean;
  before(async () => {
    setOutputMode("http");
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(left), client.connect(right)]);
  });
  after(async () => { await client.close(); await server.close(); setOutputMode("stdio"); });
  afterEach(() => mock.restoreAll());
  beforeEach(() => {
    clearLookupCache();
    file = attachment();
    writes = [];
    rejectRevision = false;
    discardUpdate = false;
    const fake = {
      endpoint: "https://finance.invalid/v3/company/", realmId: "999", token: "fiction", minorversion: 75,
      findPurchases: rows("Purchase", [purchase, { ...purchase, Id: "72" }]),
      findAttachables: rows("Attachable", [file, { Id: "82", Note: "text-only", AttachableRef: [newRef] }]),
      findCustomers: rows("Customer", [{ Id: "10", DisplayName: "Example Studio", CurrencyRef: { value: "GBP" } }]),
      findItems: rows("Item", [{ Id: "11", Name: "Travel recharge", Active: true }]),
      findInvoices: (criteria: string, cb: Callback) => {
        assert.match(criteria, /DocNumber = 'ST-23'/);
        cb(null, { QueryResponse: { Invoice: [{ Id: "73", DocNumber: "ST-23", Balance: 120 }] } });
      },
      getInvoicePdf: (id: string, cb: Callback) => { assert.equal(id, "73"); cb(null, fictionalPdf); },
      reportAgedPayables: (options: { report_date: string }, cb: Callback) => {
        assert.equal(options.report_date, "2025-04-30");
        cb(null, { Header: { ReportName: "AgedPayables", EndPeriod: options.report_date },
          Columns: { Column: [{ ColTitle: "Supplier" }, { ColTitle: "Total" }] },
          Rows: { Row: [{ ColData: [{ value: "Fictional Rail Co" }, { value: "36.00" }] }] } });
      },
      reportProfitAndLoss: (args: object, cb: Callback) => {
        assert.deepEqual(args, { accounting_method: "Accrual", start_date: "2025-04-01", end_date: "2025-04-30" });
        cb(null, { Header: { Currency: "GBP" }, Rows: { Row: [lines("Income", 800), lines("Expenses", 250), lines("NetIncome", 550)] } });
      },
    } as unknown as QuickBooks;
    mock.method(ClientSession.prototype, "get", async () => fake);
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      const { origin, pathname, searchParams } = new URL(url);
      assert.equal(origin, "https://finance.invalid");
      const prefix = "/v3/company/999";
      if (init.method === "GET" && pathname === prefix + "/purchase/71") return Response.json({ Purchase: purchase });
      if (init.method === "GET" && pathname === prefix + "/attachable/81") return Response.json({ Attachable: file });
      if (init.method === "POST" && pathname === prefix + "/upload") {
        writes.push(pathname);
        const body = init.body as FormData;
        const metadata = JSON.parse(await (body.get("file_metadata_01") as Blob).text());
        assert.deepEqual(metadata.AttachableRef, [{ EntityRef: newRef.EntityRef }]);
        const bytes = body.get("file_content_01") as File;
        assert.equal(bytes.name, "fictional-fare.pdf");
        assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), fictionalPdf);
        return Response.json({ AttachableResponse: [{ Attachable: { Id: "84", ...metadata } }] });
      }
      if (init.method === "POST" && pathname === prefix + "/attachable") {
        writes.push(pathname);
        assert.equal(searchParams.get("operation"), "update");
        const payload = JSON.parse(String(init.body));
        assert.deepEqual(payload, { Id: "81", SyncToken: "2", sparse: true, FileName: file.FileName,
          ContentType: "application/pdf", AttachableRef: [oldRef, newRef] });
        if (rejectRevision) return Response.json({ Fault: { Error: [{ code: "5010", Message: "Stale Object Error" }] } }, { status: 400 });
        if (!discardUpdate) file = { ...file, SyncToken: "3", AttachableRef: payload.AttachableRef };
        return Response.json({ Attachable: file });
      }
      throw Error("Unsupported fictional request " + init.method + " " + pathname);
    });
  });
  const args = { attachment_id: "81", target_type: "Purchase", target_id: "71" };

  it("distinguishes a file, a note, two identical purchases and an invoice with the same ID", async () => {
    const read = async (entity: string) => {
      const result = await call("query", { query: "SELECT * FROM " + entity });
      assert.equal(result.error, false, result.text);
      return JSON.parse(result.content[1].text).QueryResponse[entity];
    };
    const purchases = await read("Purchase");
    const files = await read("Attachable");
    const supported = new Set<string>();
    for (const entry of files.filter((item: { FileName?: string }) => item.FileName)) {
      for (const ref of entry.AttachableRef) supported.add(ref.EntityRef.type + ":" + ref.EntityRef.value);
    }
    assert.deepEqual(purchases.filter((p: { Id: string }) => !supported.has("Purchase:" + p.Id))
      .map((p: { Id: string }) => p.Id), ["71", "72"]);
    assert.deepEqual(writes, []);
  });
  it("previews a link, applies it once, retains the invoice link and customer sharing choice", async () => {
    const preview = await call("link_receipt_attachment", args);
    assert.match(preview.text, /DRAFT.*Invoice 71/s);
    assert.deepEqual(writes, []);
    const token = preview.text.match(/expected_sync_token="(\d+)"/)![1];
    const apply = { ...args, draft: false, expected_sync_token: token };
    const saved = await call("link_receipt_attachment", apply);
    assert.equal(saved.error, false, saved.text);
    assert.deepEqual(file.AttachableRef, [oldRef, newRef]);
    assert.match((await call("link_receipt_attachment", apply)).text, /Already linked/);
    assert.equal(writes.length, 1);
  });
  it("uploads a reviewed new file through the multipart route with one fictional write", async () => {
    const upload = { target_type: "Purchase", target_id: "71", file_name: "fictional-fare.pdf",
      content_base64: fictionalPdf.toString("base64") };
    const preview = await call("create_receipt_attachment", upload);
    assert.equal(preview.error, false, preview.text);
    assert.deepEqual(writes, []);
    const digest = preview.text.match(/SHA-256: ([0-9a-f]{64})/)![1];
    const saved = await call("create_receipt_attachment", { ...upload, draft: false, expected_sha256: digest });
    assert.equal(saved.error, false, saved.text);
    assert.match(saved.text, /Attachment ID: 84/);
    assert.deepEqual(writes, ["/v3/company/999/upload"]);
  });
  it("finds a printed invoice and retrieves its original PDF for an accountant handover", async () => {
    const found = await call("query", { query: "SELECT * FROM Invoice WHERE DocNumber = 'ST-23'" });
    assert.equal(found.error, false, found.text);
    const [{ Id }] = JSON.parse(found.content[1].text).QueryResponse.Invoice;
    const copy = await call("get_invoice_pdf", { id: Id });
    assert.equal(copy.error, false, copy.text);
    assert.deepEqual(Buffer.from(copy.content[1].text, "base64"), fictionalPdf);
    assert.deepEqual(writes, []);
  });
  it("reads the month-end supplier ageing without creating a bill payment", async () => {
    const ageing = await call("get_report", { report: "aged_payables", report_date: "2025-04-30" });
    assert.equal(ageing.error, false, ageing.text);
    assert.match(ageing.text, /Fictional Rail Co.*36\.00/);
    assert.deepEqual(writes, []);
  });
  it("rejects a stale preview, a missing revision and a note-only attachment before posting", async () => {
    for (const token of ["1", undefined]) {
      const result = await call("link_receipt_attachment", { ...args, draft: false, expected_sync_token: token });
      assert.equal(result.error, true, result.text);
    }
    file.FileName = "";
    assert.equal((await call("link_receipt_attachment", args)).error, true);
    assert.deepEqual(writes, []);
  });
  it("reports a concurrent edit without replaying it", async () => {
    rejectRevision = true;
    const result = await call("link_receipt_attachment", { ...args, draft: false, expected_sync_token: "2" });
    assert.equal(result.error, true);
    assert.match(result.text, /5010|Stale/);
    assert.equal(writes.length, 1);
  });
  it("detects an acknowledged update that is absent on read-back", async () => {
    discardUpdate = true;
    const result = await call("link_receipt_attachment", { ...args, draft: false, expected_sync_token: "2" });
    assert.equal(result.error, true);
    assert.match(result.text, /verify/);
    assert.equal(writes.length, 1);
  });
  it("previews a customer recharge for a personally paid fare without booking a second expense", async () => {
    const result = await call("create_invoice", { customer_name: "Example Studio", txn_date: "2025-04-04",
      lines: [{ item_name: "Travel recharge", qty: 2, unit_price: 24 }] });
    assert.equal(result.error, false, result.text);
    assert.match(result.text, /DRAFT/i);
    assert.match(result.text, /Example Studio/);
    assert.match(result.text, /GBP 48\.00/);
    assert.deepEqual(writes, []);
  });
  it("returns revenue, expenses and net profit for the requested accrual period", async () => {
    const result = await call("get_profit_loss", { start_date: "2025-04-01", end_date: "2025-04-30", accounting_method: "Accrual" });
    assert.equal(result.error, false, result.text);
    assert.match(result.text, /Total Income: 800\.00/);
    assert.match(result.text, /Total Expenses: 250\.00/);
    assert.match(result.text, /Net Income: 550\.00/);
    assert.deepEqual(writes, []);
  });
});

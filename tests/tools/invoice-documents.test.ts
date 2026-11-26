import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type QuickBooks from "node-quickbooks";
import { handleGetInvoicePdf } from "../../src/tools/handlers/invoice-pdf.js";
import { handleGetInvoice } from "../../src/tools/handlers/invoice.js";
import { handleCreateReceiptAttachment, type ReceiptArgs } from "../../src/tools/handlers/receipt-attachment.js";
import { newAttemptRecord, withWriteTracking } from "../../src/client/write-barrier.js";
import { setOutputMode } from "../../src/utils/output.js";

const pdf = Buffer.from("%PDF-1.7\nexample fixture");
const client = { endpoint: "https://example.invalid/v3/company/", token: "fixture-token", realmId: "123", minorversion: 75 } as unknown as QuickBooks;

it("returns the original invoice bytes on desktop and HTTP and validates the PDF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qbo-invoice-"));
  const old = process.env.QBO_PDF_OUTPUT_DIR;
  process.env.QBO_PDF_OUTPUT_DIR = dir;
  const pdfClient = { getInvoicePdf: (_id: string, cb: Function) => cb(null, pdf) } as unknown as QuickBooks;
  try {
    const local = await handleGetInvoicePdf(pdfClient, { id: "10" });
    const path = local.content[0].text.split("\nFile: ").pop()!;
    assert.deepEqual(await readFile(path), pdf);
    await assert.rejects(handleGetInvoicePdf(pdfClient, { id: "../10" }));
    const invalid = { getInvoicePdf: (_id: string, cb: Function) => cb(null, Buffer.from("not a PDF")) } as unknown as QuickBooks;
    await assert.rejects(handleGetInvoicePdf(invalid, { id: "10" }), /did not return/);
    setOutputMode("http");
    const remote = await handleGetInvoicePdf(pdfClient, { id: "10" });
    assert.deepEqual(Buffer.from(remote.content[1].text, "base64"), pdf);
  } finally {
    setOutputMode("stdio");
    if (old === undefined) delete process.env.QBO_PDF_OUTPUT_DIR; else process.env.QBO_PDF_OUTPUT_DIR = old;
    await rm(dir, { recursive: true });
  }
});

it("shows the invoice currency on totals, balance and line amounts", async () => {
  for (const code of ["GBP","USD"]) {
    const payload = { Id:"1", TotalAmt:20, Balance:5, CurrencyRef:{ value:code }, Line:[
      { Id:"1", Amount:20, SalesItemLineDetail:{ ItemRef:{ value:"5" }, Qty:2, UnitPrice:10 } },
      { DetailType:"SubTotalLineDetail", Amount:20 },
    ] };
    const fake = { getInvoice: (_id: string, cb: Function) => cb(null, payload) } as unknown as QuickBooks;
    const text = (await handleGetInvoice(fake, {id:"1"})).content[0].text;
    for (const line of [`Total: ${code} 20.00`,`Balance: ${code} 5.00`,`× ${code} 10.00`,`SubTotal: ${code} 20.00`]) assert.ok(text.includes(line), line);
  }
});

it("previews receipts, binds the reviewed bytes, and uploads metadata and file in one request", async t => {
  const dir = await mkdtemp(join(tmpdir(), "qbo-receipt-"));
  const old = process.env.QBO_RECEIPT_DIR;
  process.env.QBO_RECEIPT_DIR = dir;
  const name = "receipt.pdf";
  const args: ReceiptArgs = { target_type: "Purchase", target_id: "7", file_path: name };
  const methods: string[] = [];
  t.mock.method(globalThis,"fetch",async (url: string, init: RequestInit) => {
    methods.push(init.method!);
    if (init.method === "GET") {
      assert.match(url, /purchase\/7\?/);
      return Response.json({Purchase:{Id:"7",TxnDate:"2026-11-24"}});
    }
    assert.match(url, /\/upload\?/);
    const form = init.body as FormData;
    const metadata = JSON.parse(await (form.get("file_metadata_01") as Blob).text());
    assert.deepEqual(metadata.AttachableRef,[{EntityRef:{type:"Purchase",value:"7"}}]);
    const file = form.get("file_content_01") as File;
    assert.equal(file.type,"application/pdf");
    assert.equal(file.name,name);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()),pdf);
    return Response.json({AttachableResponse:[{Attachable:{Id:"8"}}]});
  });
  try {
    await writeFile(join(dir,name),pdf);
    const preview = (await handleCreateReceiptAttachment(client,args)).content[0].text;
    const digest = preview.match(/SHA-256: ([0-9a-f]{64})/)![1];
    assert.deepEqual(methods,["GET"]);
    await assert.rejects(handleCreateReceiptAttachment(client,{...args,draft:false,expected_sha256:"changed"}),/differs/);
    const record = newAttemptRecord();
    const upload = await withWriteTracking(record, () => handleCreateReceiptAttachment(client, {
      target_type:"Purchase",target_id:"7",file_name:name,content_base64:pdf.toString("base64"),draft:false,expected_sha256:digest,
    }));
    assert.equal(record.writeIssued,true);
    assert.match(upload.content[0].text,/Attachment ID: 8/);
    assert.deepEqual(methods,["GET","GET","POST"]);
    setOutputMode("http");
    await assert.rejects(handleCreateReceiptAttachment(client,args),/local file_path/);
  } finally {
    setOutputMode("stdio");
    if (old === undefined) delete process.env.QBO_RECEIPT_DIR; else process.env.QBO_RECEIPT_DIR = old;
    await rm(dir,{recursive:true});
  }
});

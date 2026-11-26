import QuickBooks from "node-quickbooks";
import { promisify } from "../../client/index.js";
import { writeInvoicePdf } from "../../utils/files.js";
import { isHttpMode } from "../../utils/output.js";

export async function handleGetInvoicePdf(client: QuickBooks, { id }: { id: string }) {
  if (typeof id !== "string" || !/^\d+$/.test(id)) throw new Error("A numeric QuickBooks invoice ID is required.");
  const pdf = await promisify<Buffer>(cb => client.getInvoicePdf(id, cb));
  if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("QuickBooks did not return an invoice PDF.");
  }
  if (pdf.length > 50 * 1024 * 1024) throw new Error("Invoice PDF exceeds 50 MiB.");
  if (isHttpMode()) {
    return { content: [
      { type: "text" as const, text: `Invoice ${id}, application/pdf, ${pdf.length} bytes (base64 follows).` },
      { type: "text" as const, text: pdf.toString("base64") },
    ] };
  }
  const path = writeInvoicePdf(id, pdf);
  return { content: [{ type: "text" as const, text: `Invoice ${id}, PDF, ${pdf.length} bytes\nFile: ${path}` }] };
}

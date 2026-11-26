// Protocol v1. Fictional development prompts, independently labelled by task.
// This tests lexical retrieval from wire metadata, not a model's final answer.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const cases = [
  ["upload", "Upload a new JPEG receipt for a recorded expense", ["create_receipt_attachment"]],
  ["reuse", "Link an existing uploaded receipt to a posted purchase", ["link_receipt_attachment"]],
  ["coverage", "Audit missing receipt files using Attachable and Purchase records", ["query"]],
  ["recharge", "Preview a customer invoice for a travel recharge", ["create_invoice"]],
  ["invoice-copy", "Download the original PDF for an invoice number", ["get_invoice_pdf"]],
  ["profit", "What was our revenue and net profit on an accrual basis?", ["get_profit_loss"]],
  ["debtors", "Show aged receivables and overdue customer balances", ["get_report"]],
  ["creditors", "Which supplier bills remain unpaid? Show aged payables", ["get_report"]],
  ["close", "Review the trial balance for suspense and uncategorized balances", ["get_trial_balance"]],
  ["cash", "Show cash flow for the month", ["get_report"]],
  ["transfer", "Transfer cash between two company bank accounts", ["create_transfer"]],
  ["collections", "Record a customer payment against outstanding invoices", ["receive_payment"]],
  ["bank-review", "Find posted transactions affecting one bank account", ["query_account_transactions"]],
  ["financial-position", "Get the balance sheet at month end", ["get_balance_sheet"]],
];
const stop = new Set("a an and are as at between by for from get how in on one or our show the to two using was what which".split(" "));
const words = text => (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(word => !stop.has(word));
const client = new Client({ name: "finance-discovery-eval", version: "1" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(process.argv[2] || "dist/index.js")], stderr: "pipe" }));
  const { tools } = await client.listTools();
  const docs = tools.map(tool => ({
    name: tool.name,
    title: new Set(words(tool.name + " " + tool.annotations?.title)),
    body: new Set(words(tool.description || "")),
  }));
  const idf = word => Math.log(1 + docs.length / (1 + docs.filter(d => d.title.has(word) || d.body.has(word)).length));
  let passed = 0;
  for (const [id, prompt, accepted] of cases) {
    const terms = [...new Set(words(prompt))];
    const ranked = docs.map(doc => ({ name: doc.name, score: terms.reduce((sum, word) =>
      sum + idf(word) * (Number(doc.title.has(word)) * 2 + Number(doc.body.has(word))), 0) }))
      .filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const candidates = ranked.slice(0, 3).map(row => row.name);
    const pass = candidates.some(name => accepted.includes(name));
    if (pass) passed++;
    console.log(JSON.stringify({ id, prompt, accepted, candidates, outcome: pass ? "pass" : "fail" }));
  }
  console.log(`Discovery v1: ${passed}/${cases.length} tasks found an expected tool in the first three results (${tools.length} advertised tools).`);
  if (passed !== cases.length) process.exitCode = 1;
} finally {
  await client.close();
}

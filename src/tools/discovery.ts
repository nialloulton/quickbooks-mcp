interface ListedTool {
  name: string;
  annotations: { readOnlyHint: boolean };
}

/** Build the index from the actual transport so local-only tools stay local. */
export function financeInstructions(tools: ListedTool[]): string {
  const names = (readOnly: boolean) => tools.filter(tool => tool.annotations.readOnlyHint === readOnly)
    .map(tool => tool.name).join(", ");
  return [
    "QuickBooks Online finance tools. Use tools/list for exact names, argument schemas and write annotations.",
    "For receipt audits, query posted Purchase and Attachable records. Compare AttachableRef by entity type and ID across all pages. A missing file link, an unlinked upload and an uncategorised posting are separate findings. The pending bank feed and receipt capture inbox are outside this server.",
    "For a new receipt use create_receipt_attachment. For a file already in the Attachments list use link_receipt_attachment. Resolve the target first. Ambiguous matches, personally paid costs and client recharges need payer and beneficiary evidence. Drive, mail and calendar evidence comes from the respective connectors.",
    "For customer billing, look up the existing invoice and DocNumber first. Use create_invoice for a recharge preview, get_invoice_pdf for its document, and receive_payment for an authorised customer payment. Use get_report for debtors, creditors and cash flow. Use get_profit_loss for revenue and profit and get_balance_sheet and get_trial_balance for period close.",
    "For learning, audit or accountant evidence requests use read-only tools. Keep posting, sending, classification and attachment changes within the user's request.",
    "Read-only tools: " + names(true) + ".",
    "Tools that can change state: " + names(false) + ".",
  ].join("\n");
}

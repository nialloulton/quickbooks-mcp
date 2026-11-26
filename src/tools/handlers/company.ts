// Handler for get_company_info tool

import QuickBooks from "node-quickbooks";
import { promisify } from "../../client/index.js";

export async function handleGetCompanyInfo(client: QuickBooks): Promise<{ content: Array<{ type: string; text: string }> }> {
  const result = await promisify<unknown>((cb) =>
    client.getCompanyInfo(client.realmId, cb)
  );
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

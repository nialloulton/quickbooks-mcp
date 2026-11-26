# QuickBooks MCP Server

This checkout includes local security changes that have not been published to npm. Use **Option 2: Local Checkout** to run this version; `npx quickbooks-mcp` installs the upstream package. See [secure setup and migration](docs/security.md).

An MCP server for QuickBooks Online — built for bookkeepers, CFOs, and accountants who use AI assistants in their daily workflow.

Ask your AI assistant to pull a P&L report, create a journal entry, or investigate an account balance — using plain language, not API payloads.

## Invoice PDFs and receipt attachments

Use `get_invoice_pdf` with the internal invoice ID. To find an invoice by its printed number, query `Invoice` by `DocNumber` first. The desktop tool returns a private temporary PDF path valid for the server session. Set `QBO_PDF_OUTPUT_DIR` to an existing folder to keep PDFs there. HTTP clients receive base64.

Use `create_receipt_attachment` with the target type (`Bill`, `Purchase` for an expense, `Invoice` or `SalesReceipt`) and internal ID. Supply a PDF, JPEG or PNG via `file_name` and `content_base64`, or use `file_path` on desktop. The receipt folder defaults to `~/Documents/QuickBooks Receipts` and can be selected with `QBO_RECEIPT_DIR`. The default preview identifies the transaction and file digest. To post, pass `draft=false` and the preview's `expected_sha256`.

Use `link_receipt_attachment` for a file already in the QuickBooks Attachments list. Find the file via `query` on `Attachable`, resolve the posted target and preview the pair of internal IDs. Applying a new link takes the attachment's `expected_sync_token` from the preview and `draft=false`. The tool preserves existing links, leaves customer distribution off for the new link and reads the saved references back. A repeat on an existing pair returns “Already linked”.

## Finding tools in Codex

The server returns a tool index during MCP initialisation. Its `tools/list` response has the exact name, purpose, argument schema and read/write annotations for every available operation. In Codex, look under the configured `quickbooks` server, for example `mcp__quickbooks__link_receipt_attachment`. The two local OAuth tools are available on desktop. If the catalogue predates an update, reconnect the MCP server or start a fresh Codex session and check the tool names again.

See [finance workflows and fictional evaluations](docs/finance-workflows.md) for receipt review, reimbursements, recharges, reporting and accountant handovers.

## Why This Server?

Intuit provides an [official MCP server](https://github.com/intuit/quickbooks-online-mcp-server) that's a solid starting point for developers exploring the QuickBooks API. This server takes a different approach: it's designed for **financial professionals working in production books**.

### Use natural language, not internal IDs

Intuit's server requires QuickBooks internal IDs for every reference — you need to look up a vendor's ID before creating a bill. This server resolves names automatically:

```
"Preview a fictional $100 utilities bill from Example Energy, dated 2025-04-01"
→ Vendor, account, and department names are resolved automatically
```

### Financial reports built in

This is the only QuickBooks MCP server with report tools. Pull a P&L, Balance Sheet, or Trial Balance — broken down by month, department, or class — without leaving your AI conversation.

### Safe by default

Every create and edit operation defaults to **draft/preview mode**. You see exactly what will be written to your books before committing. No accidental journal entries or misclassified expenses.

### One query tool instead of dozens

Instead of separate search tools for each entity type, a single SQL-like `query` tool works across all QuickBooks entities. AI assistants write SQL naturally, and QuickBooks validates it — no field whitelists to maintain.

```
"SELECT * FROM Purchase WHERE TxnDate >= '2025-01-01' AND TxnDate <= '2025-01-31'"
```

### Production-ready credential management

Store credentials locally for personal use, or in AWS Secrets Manager for shared environments. OAuth tokens refresh automatically and persist across sessions.

### At a glance

| | Intuit Official | This Server |
|--|-----------------|-------------|
| **Audience** | Developers exploring the API | Bookkeepers, CFOs, accountants |
| **Name resolution** | Requires internal QB IDs | Resolves names automatically |
| **Financial reports** | None | P&L, Balance Sheet, Trial Balance |
| **Write safety** | Executes immediately | Draft preview by default |
| **Query approach** | Entity-specific search tools | SQL-like queries across all entities |
| **Credentials** | Local `.env` file | Local file or AWS Secrets Manager |
| **Distribution** | Clone from GitHub | `npx quickbooks-mcp` |

## Prerequisites

- **QuickBooks Developer Account**: Register at [developer.intuit.com](https://developer.intuit.com)
- **Node.js 22+**

## Installation Options

Choose the setup that fits your use case:

| Setup | Best For |
|-------|----------|
| [NPM Install](#option-1-npm-install) | Quick setup, using your own QuickBooks app |
| [Local Checkout](#option-2-local-checkout) | Development, customization |
| [AWS Mode](#option-3-aws-mode) | Shared/production environments |

---

## Option 1: NPM Install

The simplest way to get started. Credentials are stored locally on your machine.

### 1. Create a QuickBooks App

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in
2. Create a new app (or select an existing one)
3. Go to "Keys & credentials"
4. Note your **Client ID** and **Client Secret**
5. Under "Redirect URIs", add: `https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl`

### 2. Add to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "npx",
      "args": ["-y", "quickbooks-mcp"]
    }
  }
}
```

### 3. Configure Credentials

Create `~/.quickbooks-mcp/credentials.json`:

```json
{
  "client_id": "your_client_id",
  "client_secret": "your_client_secret"
}
```

### 4. Authenticate

Once Claude Code is running, use the `qbo_authenticate` tool:

1. Call `qbo_authenticate` with no arguments to get an authorization URL
2. Open the URL in your browser and authorize the app
3. Copy the complete final redirect URL, including `code`, `realmId`, and `state`
4. In the same running MCP session, call `qbo_authenticate` with `{ "callback_url": "<complete redirect URL>" }`

Complete the flow within ten minutes. Restarting the server or starting another flow invalidates the previous link. Treat the callback URL as a temporary secret.

Your OAuth tokens will be saved and automatically refreshed.

---

## Option 2: Local Checkout

For development or customization.

### 1. Create a QuickBooks App

Follow the same steps as Option 1 above.

### 2. Clone and Build

```bash
git clone https://github.com/nialloulton/quickbooks-mcp.git
cd quickbooks-mcp
npm install
npm run build
```

### 3. Add to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["/path/to/quickbooks-mcp/dist/index.js"]
    }
  }
}
```

### 4. Configure Credentials

Create `~/.quickbooks-mcp/credentials.json` with your client credentials (same as Option 1), then run `npm run security:migrate` before authenticating. Windows replaces the plaintext with a DPAPI-encrypted file; macOS moves it into your login Keychain and removes the plaintext after verification. Linux uses an owner-only file. Use the full callback URL flow above with `qbo_authenticate`.

Do not copy the encrypted Windows file to a Mac. Configure the app credentials on the Mac and authorize again. See [platform setup and security](docs/security.md) for environment selection and storage details.

---

## Option 3: AWS Mode

For shared or production environments. Stores credentials in AWS Secrets Manager.

### 1. Create AWS Resources

**Create the secret in Secrets Manager:**

```bash
aws secretsmanager create-secret \
  --name prod/qbo \
  --secret-string '{
    "client_id": "your_client_id",
    "client_secret": "your_client_secret",
    "access_token": "your_access_token",
    "refresh_token": "your_refresh_token",
    "redirect_url": "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl"
  }'
```

**Store Company ID in SSM Parameter Store:**

```bash
aws ssm put-parameter \
  --name /prod/qbo/company_id \
  --value "your_company_id" \
  --type SecureString
```

### 2. Configure the Server

Create a `.env` file in the quickbooks-mcp directory:

```bash
QBO_CREDENTIAL_MODE=aws
AWS_REGION=us-east-2
QBO_SECRET_NAME=prod/qbo
QBO_COMPANY_ID_PARAM=/prod/qbo/company_id
```

> **Note**: Due to a [known Claude Code bug](https://github.com/anthropics/claude-code/issues/1254), environment variables from `.mcp.json` are not reliably passed to MCP servers. The `.env` file workaround is required.

### 3. Add to Claude Code

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "node",
      "args": ["/path/to/quickbooks-mcp/dist/index.js"]
    }
  }
}
```

### 4. IAM Permissions

The server needs these AWS permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:*:*:secret:prod/qbo*"
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": "arn:aws:ssm:*:*:parameter/prod/qbo/*"
    }
  ]
}
```

---

## Inline Output Mode

By default, large responses (reports, query results) are written to `/tmp` files and the server returns a file path. This works well for Claude Code in terminal environments but breaks in **Claude Desktop** and **plugin environments** where the model cannot read from `/tmp`.

Set `QBO_INLINE_OUTPUT=true` to return all responses inline instead.

**Option A — via `.env` file** (recommended for local checkout):

Create a `.env` file in the quickbooks-mcp directory:

```bash
QBO_INLINE_OUTPUT=true
```

**Option B — via `.mcp.json` env block** (recommended for NPM install):

```json
{
  "mcpServers": {
    "quickbooks": {
      "command": "npx",
      "args": ["-y", "quickbooks-mcp"],
      "env": {
        "QBO_CREDENTIAL_MODE": "local",
        "QBO_INLINE_OUTPUT": "true"
      }
    }
  }
}
```

> **Note**: Due to a [known Claude Code bug](https://github.com/anthropics/claude-code/issues/1254), environment variables from `.mcp.json` are not reliably passed to MCP servers in some configurations. If Option B doesn't work, use the `.env` file workaround.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QBO_CREDENTIAL_MODE` | `local` | Credential storage: `local` or `aws` |
| `QBO_CLIENT_ID` | - | QuickBooks app Client ID (local mode) |
| `QBO_CLIENT_SECRET` | - | QuickBooks app Client Secret (local mode) |
| `QBO_CREDENTIAL_FILE` | `~/.quickbooks-mcp/credentials.json` | Windows encrypted file / Linux private file / macOS bootstrap file and Keychain profile identifier. A leading `~` expands to your home directory. |
| `QBO_LOG_DIR` | `~/.quickbooks-mcp/logs` | Private directory for metadata-only diagnostics. Existing matching log files are sanitized during migration. |
| `QBO_INLINE_OUTPUT` | `false` | Return responses inline instead of writing to `/tmp` files. Required when using Claude Desktop or plugin environments where file-based output is not accessible to the model. |
| `QBO_SANDBOX` | `false` | Use QuickBooks sandbox environment. Also switches the "View in QuickBooks" deep links to `app.sandbox.qbo.intuit.com` so they cannot open the production company. |
| `AWS_REGION` | `us-east-2` | AWS region (aws mode) |
| `QBO_SECRET_NAME` | `prod/qbo` | Secrets Manager secret name (aws mode) |
| `QBO_COMPANY_ID_PARAM` | `/prod/qbo/company_id` | SSM parameter path (aws mode) |

---

## Available Tools

| Tool | Description |
|------|-------------|
| **Setup** | |
| `qbo_authenticate` | Set up OAuth credentials (local mode only) |
| `qbo_disconnect` | Revoke OAuth credentials (local mode only) |
| `get_company_info` | Get connected company information |
| **Query & Reports** | |
| `query` | Run SQL-like queries against any QuickBooks entity |
| `list_accounts` | List chart of accounts with filtering |
| `get_profit_loss` | Profit & Loss report (by month, department, class, etc.) |
| `get_balance_sheet` | Balance Sheet report |
| `get_trial_balance` | Trial Balance report (`flags: true` adds a close-review pass for wrong-side and uncategorized/suspense balances) |
| `get_report` | Any of 24 other QuickBooks reports — A/R and A/P aging, customer and vendor balances, transaction lists, general ledger, journal, sales by customer/item/class/department, cash flow, and the detail variants |
| `query_account_transactions` | All transactions affecting a specific account (13 posting entity types, paginated, optional sub-account rollup; see `docs/entity-coverage.md` for limits) |
| `account_period_summary` | Period summary for an account (opening/closing balance, debits, credits, count) |
| **Journal Entries** | |
| `create_journal_entry` | Create a journal entry (validates debits = credits; lines take `entity_name`/`entity_type`) |
| `get_journal_entry` | Fetch a journal entry by ID |
| `edit_journal_entry` | Modify an existing journal entry |
| **Bills** | |
| `create_bill` | Create a vendor bill (lines take `customer_name`) |
| `get_bill` | Fetch a bill by ID |
| `edit_bill` | Modify an existing bill |
| **Expenses** | |
| `create_expense` | Create an expense (Cash, Check, or Credit Card; payee may be a vendor, customer, or employee) |
| `get_expense` | Fetch an expense by ID |
| `edit_expense` | Modify an existing expense |
| **Sales Receipts** | |
| `create_sales_receipt` | Create a sales receipt with item lines |
| `get_sales_receipt` | Fetch a sales receipt by ID |
| `edit_sales_receipt` | Modify an existing sales receipt |
| **Invoices** | |
| `create_invoice` | Create an invoice with item lines (customer required) |
| `get_invoice` | Fetch an invoice by ID |
| `edit_invoice` | Modify an existing invoice |
| `get_invoice_pdf` | Download the original invoice PDF by internal ID |
| **Receipt evidence** | |
| `create_receipt_attachment` | Preview or upload a new receipt to a posted transaction |
| `link_receipt_attachment` | Preview or link a file already uploaded to QuickBooks |
| **Customers** | |
| `get_customer` | Fetch a customer by ID |
| `create_customer` | Preview or create a customer |
| `edit_customer` | Preview or update a customer |
| **Deposits** | |
| `create_deposit` | Create a bank deposit (lines take `entity_name`/`entity_type`) |
| `get_deposit` | Fetch a deposit by ID |
| `edit_deposit` | Modify an existing deposit (lines take `entity_name`/`entity_type`) |
| **Vendor Credits** | |
| `create_vendor_credit` | Create a vendor credit (lines take `customer_name`) |
| `get_vendor_credit` | Fetch a vendor credit by ID |
| `edit_vendor_credit` | Modify an existing vendor credit |
| **Bill Payments** | |
| `create_bill_payment` | Pay bills and apply vendor credits (the QBO "check" / pay-bills flow) |
| `receive_payment` | Record a customer payment against open invoices (A/R counterpart to `create_bill_payment`); each line defaults to the invoice's open balance |
| `create_transfer` | Move money between two of the company's own accounts (bank↔bank, credit-card paydown) |
| `get_bill_payment` | Fetch a bill payment by ID; flags unapplied amounts |
| **Vendors** | |
| `create_vendor` | Create a vendor (contact, billing address, terms, account number, 1099 flag) |
| `edit_vendor` | Sparse-update a vendor; `active: false` deactivates. Read vendors with `query` |
| **Delete** | |
| `delete_entity` | Delete any transaction (journal entry, bill, invoice, deposit, sales receipt, expense, vendor credit, bill payment) |

### Naming Vendors, Customers, and Employees

Every write tool that can attribute a line or a header to a name list accepts a
name and resolves it to an ID, the same way `account_name` and
`department_name` do. Which parameter you get depends on what QuickBooks will
actually store there:

| Parameter | Where it applies | Accepts |
|-----------|------------------|---------|
| `entity_name` + `entity_type` | `create_deposit` / `edit_deposit` lines, `create_journal_entry` / `edit_journal_entry` lines, `create_expense` / `edit_expense` header payee | Vendor, Customer, or Employee. `entity_type` defaults to `Vendor`. |
| `customer_name` | `create_bill` / `edit_bill`, `create_expense` / `edit_expense`, `create_vendor_credit` / `edit_vendor_credit` lines | Customer only — QuickBooks stores a `CustomerRef` on these lines and has no vendor or employee option. |
| `vendor_name` | `create_bill`, `create_vendor_credit`, `create_bill_payment` headers | Vendor only. |
| `customer_name` (header) | `create_invoice`, `create_sales_receipt` | Customer only. Their item lines have no per-line entity. |

Each also has an `_id` form (`entity_id`, `customer_id`) if you already know the
internal ID. On edit tools, the rule for line parameters is:

- **omit** the parameter and a line addressed by `line_id` keeps the entity it
  already has;
- **name** one and it is set or replaced;
- **pass an empty string** (`entity_name: ""`) and it is cleared.

See [`docs/quickbooks-api-limitations.md`](docs/quickbooks-api-limitations.md#entity-attribution-is-four-different-fields)
for the underlying QBO field shapes, which are not uniform.

### Parameter Names Are Enforced

Arguments are checked against the schema each tool advertises, before anything
runs. An unknown parameter is an error that names the closest valid one, a
missing required parameter is an error, and an `edit_*` call with no field to
change is an error rather than a write that reports success.

The alternative is silence. A handler reads the parameters it knows about, so a
misspelled one is simply absent: a create call that puts the date under the
wrong key posts on today's date, an as-of report asked for a date range returns
today's balances, and an edit whose fields are all misspelled comes back
"updated successfully" having changed nothing. None of those raise anything for
the caller to notice.

Relatedly, when QuickBooks accepts an update without advancing the record's
`SyncToken` — meaning the payload matched what was already stored — the edit
tools report no change instead of success.

---

## Token Refresh

The server automatically refreshes OAuth tokens on each request and persists them back to your credential store (local file or AWS Secrets Manager).

---

## Development

```bash
npm run dev           # Rebuild on changes
npm run build         # Type-check and build the desktop server
npm run test:desktop  # Focused tests used on pull requests
npm test              # Full regression suite
```

Each pull request runs one Windows job covering the desktop build, dependency audit, receipt workflows, credential storage, write retries and tool discovery. A new commit supersedes the previous PR run. To run the full suite, Lambda build and package check, select **Actions → Windows desktop CI → Run workflow**.

Tests live in `tests/`, mirroring `src/`. They are TypeScript, compiled by
`tsconfig.test.json` into `dist-test/` and run by Node's built-in test runner —
no test framework dependency. Type errors in a test are build failures, so a
test referencing a renamed export fails loudly rather than silently skipping.
Anything needing a QuickBooks client passes a hand-written stand-in covering
just the calls under test, so the suite runs offline with no credentials.

---

## Troubleshooting

### "QuickBooks credentials not configured"

Run the `qbo_authenticate` tool to set up OAuth credentials (local mode only).

### "Authorization code expired"

Authorization codes are only valid for a few minutes. Start the OAuth flow again.

### Token refresh fails

- Check that your refresh token hasn't expired (~100 days)
- Verify your client credentials are correct
- Try re-authenticating with `qbo_authenticate`

### AWS credential errors

- Ensure `.env` file has `QBO_CREDENTIAL_MODE=aws`
- Check your AWS credentials and permissions
- Verify the secret and parameter names match your configuration

## Support

If you encounter issues:

1. **Check the error message** — errors include the `intuit_tid` value which helps identify the exact API call that failed
2. **Review the logs** — tool name, outcome, timestamp, status/fault code and validated `intuit_tid` are stored in `~/.quickbooks-mcp/logs/quickbooks-mcp.log`; raw errors, request bodies, credentials and transaction data are excluded
3. **Open an issue** — visit [github.com/nialloulton/quickbooks-mcp/issues](https://github.com/nialloulton/quickbooks-mcp/issues) with:
   - A reviewed, redacted error description and `intuit_tid` value; never include keys, tokens, callback URLs, or customer financial data
   - The tool/action you were trying to use
   - Your QuickBooks Online plan (Simple Start, Essentials, Plus, or Advanced)

**Common error patterns:**
- `refresh token has expired` — run `qbo_authenticate` to reconnect (tokens expire after 100 days)
- `CSRF or state parameter mismatch` — run `qbo_authenticate` to start a fresh auth flow
- `3200` or `401` errors — authentication issue, the app will auto-retry once then prompt you to reconnect

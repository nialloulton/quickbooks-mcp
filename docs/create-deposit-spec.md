# Feature Spec: `create_deposit`

## Summary

Add a `create_deposit` MCP tool that creates bank deposit transactions in QuickBooks Online. This completes the deposit CRUD cycle alongside the existing `get_deposit` and `edit_deposit` tools.

## Motivation

Deposits are manually created during reconciliation workflows when recording how money arrives in a bank account. The typical use case is recording third-party payment processor deposits where a gross amount arrives in the bank, broken into income/asset lines and fee deductions.

**Fictional example**
> "Preview a deposit from Example Processor for Example North on 2025-04-01 to Example Operating Bank. The $85.00 deposit comprises $100.00 of sales, less $10.00 already received in cash and a $5.00 processing fee."

## QuickBooks API Reference

- **Endpoint:** `POST /v3/company/{realmId}/deposit`
- **node-quickbooks method:** `client.createDeposit(object, callback)`
- **Docs:** [Intuit Developer - Deposit Entity](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/deposit)

### Required Fields (Create)

| Field | Type | Notes |
|-------|------|-------|
| `DepositToAccountRef` | `{ value: string }` | Bank account receiving the deposit |
| `Line[]` | Array | At least one line item required |

### Required Line Fields

| Field | Type | Notes |
|-------|------|-------|
| `Amount` | number | Can be negative (fees, deductions) |
| `DetailType` | string | Always `"DepositLineDetail"` |
| `DepositLineDetail.AccountRef` | `{ value: string }` | Source account for this line |

### Optional Fields

| Field | Type | Notes |
|-------|------|-------|
| `TxnDate` | string | Date in YYYY-MM-DD (defaults to today if omitted) |
| `DepartmentRef` | `{ value: string }` | Header-level department/location (store) |
| `PrivateNote` | string | Internal memo |
| `CurrencyRef` | `{ value: string }` | Currency (defaults to company currency) |
| `Line[].Description` | string | Line description text |
| `Line[].DepositLineDetail.Entity` | `{ value, name, type }` | Vendor/customer reference on line |
| `Line[].DepositLineDetail.ClassRef` | `{ value: string }` | Class tracking on line |
| `Line[].DepositLineDetail.PaymentMethodRef` | `{ value: string }` | Payment method (not needed for typical use) |

### API Behavior

- `TotalAmt` is **computed by QuickBooks** as the sum of all line amounts. Do not send it.
- Line amounts can be negative (bank fees, cash already collected, etc.).
- The QB API will reject the request if `DepositToAccountRef` points to a non-Bank account type.
- `Entity` on lines is optional and references the vendor/customer associated with that line item (e.g., Example Processor for a processing fee line).

## Tool Definition

### `create_deposit`

**Description:** Create a bank deposit. Accepts account/department/vendor names (will lookup IDs automatically). Lines represent the sources of the deposit — amounts can be positive (income) or negative (fees, deductions). QuickBooks computes the total from line amounts. Returns deposit details and a link to view in QuickBooks.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `deposit_to_account` | string | **Yes** | Bank account name or number (e.g., `"Example Operating Bank"`, `"1000"`). Resolved via account cache. |
| `txn_date` | string | **Yes** | Transaction date in YYYY-MM-DD format. |
| `lines` | array | **Yes** | At least one line item (see Line Parameters below). |
| `department_name` | string | No | Header-level department/location name (e.g., `"Example North"`, `"Example South"`). Resolved via department cache. |
| `department_id` | string | No | Header-level department ID (use if known, otherwise use `department_name`). |
| `memo` | string | No | Private memo for the deposit. |
| `draft` | boolean | No | If `true` (default), validate and show preview without creating. Set `false` to create. |

### Line Parameters

Each line in the `lines` array:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `amount` | number | **Yes** | Line amount. Can be positive or negative. |
| `account_name` | string | **Yes*** | Source account name or number (e.g., `"Example Clearing"`, `"1100"`, `"6000"`). Resolved via account cache. |
| `account_id` | string | **Yes*** | Account ID (use if known, otherwise use `account_name`). |
| `description` | string | No | Line description text. |
| `entity_name` | string | No | Vendor, customer, or employee name. Sets `DepositLineDetail.Entity`. |
| `entity_id` | string | No | Entity ID (use if known, otherwise use `entity_name`). |
| `entity_type` | string | No | `Vendor` (default), `Customer`, or `Employee` — which name list to search. |

\* One of `account_name` or `account_id` is required per line.

## Implementation

### Files to Modify

| File | Change |
|------|--------|
| `src/tools/handlers/deposit.ts` | Add `handleCreateDeposit` function |
| `src/tools/definitions.ts` | Add `create_deposit` tool definition |
| `src/tools/handlers/index.ts` | Export `handleCreateDeposit` |
| `src/tools/index.ts` | Register `create_deposit` in toolHandlers map |

### Handler Logic (`handleCreateDeposit`)

Follow the `handleCreateBill` pattern:

```
1. Validate at least one line exists
2. Parallel cache fetch: getAccountCache, getDepartmentCache, getVendorCache
3. Resolve deposit_to_account → DepositToAccountRef (account cache)
4. Resolve department_name/id → DepartmentRef (department cache)
5. For each line:
   a. Resolve account_name/id → AccountRef (account cache)
   b. Validate amount with validateAmount() (handles negatives)
   c. If entity_name/id provided → resolve to Entity ref against the list named by entity_type
6. Build QB deposit object
7. If draft: format preview and return
8. Call client.createDeposit(object, callback)
9. Return success with ID and QBO URL
```

### Draft Preview Format

```
DRAFT - Deposit Preview

Date: 2025-04-01
Deposit To: Example Operating Bank (1000)
Department: Example North
Memo: (none)

Lines:
  1100 Example Clearing: $100.00 "total sales"
  1100 Example Clearing: $-10.00 "cash sales"
  6000 Processing Fees: $-5.00 [Example Processor] "EXAMPLE-FEE"
  ─────────────
  Total: $85.00

Set draft=false to create this deposit.
```

### Success Response Format

```
Deposit Created!

ID: 71
Date: 2025-04-01
Deposit To: Example Operating Bank (1000)
Department: Example North
Total: $85.00

View in QuickBooks: https://example.invalid/app/deposit?txnId=71
```

### QB Object Structure

The object sent to `client.createDeposit()`:

```json
{
  "DepositToAccountRef": { "value": "10", "name": "Example Operating Bank (1000)" },
  "TxnDate": "2025-04-01",
  "DepartmentRef": { "value": "14", "name": "Example North" },
  "PrivateNote": "optional memo",
  "Line": [
    {
      "Amount": 100.00,
      "DetailType": "DepositLineDetail",
      "Description": "total sales",
      "DepositLineDetail": {
        "AccountRef": { "value": "11", "name": "1100 Other Current Assets:Example Clearing" }
      }
    },
    {
      "Amount": -10.00,
      "DetailType": "DepositLineDetail",
      "Description": "cash sales",
      "DepositLineDetail": {
        "AccountRef": { "value": "11", "name": "1100 Other Current Assets:Example Clearing" }
      }
    },
    {
      "Amount": -5.00,
      "DetailType": "DepositLineDetail",
      "Description": "EXAMPLE-FEE",
      "DepositLineDetail": {
        "AccountRef": { "value": "12", "name": "6000 Processing Fees" },
        "Entity": { "value": "13", "name": "Example Processor", "type": "VENDOR" }
      }
    }
  ]
}
```

## Validation Rules

| Rule | Details |
|------|---------|
| At least one line | Throw if `lines` is empty or missing |
| Amount precision | `validateAmount()` rejects >2 decimal places, handles negatives |
| Account resolution | All account names resolved via cache; throw on not found |
| Department resolution | Optional; resolved via cache; throw on not found |
| Vendor resolution | Optional; resolved via vendor cache with partial match; throw on not found |
| Bank account type | Let QB API validate — it rejects non-Bank accounts with a clear error |
| No total validation | Unlike `edit_deposit`, create does not validate totals (QB computes `TotalAmt`) |

## Entity Resolution on Lines

The `Entity` field on deposit lines associates a vendor or customer with the line. This is used for:
- Bank fee lines tied to a specific processor (Example Processor)
- Vendor credit deposits
- Customer payment deposits

Resolution goes through `src/client/entity-refs.ts`, which applies the same
precedence to each name list:
1. Try exact ID match
2. Try exact name match (case-insensitive)
3. Try partial DisplayName match
4. Throw if not found

**Superseded:** this spec originally shipped vendor-only lines and deferred an
`entity_type` parameter. It now exists on both `create_deposit` and
`edit_deposit` and takes `Vendor` (default), `Customer`, or `Employee`; the
resolved kind is uppercased into the `type` attribute QBO round-trips on a
deposit line. `edit_deposit` accepts the same triple on new and existing lines,
and a line addressed by `line_id` keeps its existing `Entity` when none is
given.

## Edge Cases

| Scenario | Handling |
|----------|----------|
| All negative lines | Valid — QB accepts any total (could be net negative). Unlikely in practice. |
| Zero total | Valid — all lines could cancel out. QB computes TotalAmt = 0. |
| Single line | Valid — simple deposit with one source. |
| Very long descriptions | QB API truncates or rejects at ~4000 chars. Let API handle. |
| Duplicate account on multiple lines | Valid — same account can appear multiple times (e.g., Example Clearing for gross and cash deduction). |
| Entity on create | The QB API accepts Entity on DepositLineDetail during create. If this fails in practice, the parameter can be made no-op with a warning. |

## Testing

### Manual Test Cases

1. **Simple deposit** — Single line, positive amount, no entity
2. **Multi-line with fees** — Positive income lines + negative fee line with entity
3. **Draft preview** — Verify preview formatting before creation
4. **Name resolution** — Use account numbers, partial names, department names
5. **Negative amount** — Verify `validateAmount()` handles -$5.00 correctly
6. **Entity on line** — Create deposit with vendor entity on fee line
7. **Verify in QBO UI** — After creation, open the QBO link and confirm all fields match

### Regression

- Existing `get_deposit` and `edit_deposit` should be unaffected (no changes to those functions)
- Account/department/vendor cache behavior unchanged (read-only usage)

## Backlog Update

After implementation, update `docs/quickbooks-mcp-backlog.md`:
- Move `create_deposit` from Backlog to Completed under "Create Transaction Tools"

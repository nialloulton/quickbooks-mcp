// QuickBooks report and transaction types

// Common QuickBooks reference type
export interface QBRef {
  value: string;
  name?: string;
}

// QuickBooks API error structure
// QB API returns capitalized Fault.Error, but node-quickbooks may use lowercase
export interface QBError {
  Fault?: {
    Error?: Array<{ code?: string; Code?: string; message?: string; Message?: string; Detail?: string; detail?: string }>;
  };
  fault?: {
    error?: Array<{ code?: string; Code?: string; message?: string; Message?: string; Detail?: string; detail?: string }>;
  };
}

// Type guard for QB error objects (handles both casings)
export function isQBError(error: unknown): error is QBError {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as Record<string, unknown>;
  // Check capitalized (actual QB API)
  if (err.Fault && typeof err.Fault === 'object') {
    const fault = err.Fault as Record<string, unknown>;
    if (Array.isArray(fault.Error)) return true;
  }
  // Check lowercase (node-quickbooks legacy)
  if (err.fault && typeof err.fault === 'object') {
    const fault = err.fault as Record<string, unknown>;
    if (Array.isArray(fault.error)) return true;
  }
  return false;
}

// Extract normalized error info from a QB error (casing-safe)
export function extractQBErrorInfo(error: QBError): { code?: string; message?: string; detail?: string } {
  const errors = error.Fault?.Error ?? error.fault?.error;
  if (!errors || errors.length === 0) return {};
  const first = errors[0];
  return {
    code: first.Code ?? first.code,
    message: first.Message ?? first.message,
    detail: first.Detail ?? first.detail,
  };
}

// QuickBooks entity base
export interface QBEntity {
  Id: string;
  SyncToken?: string;
  TxnDate?: string;
  DocNumber?: string;
  PrivateNote?: string;
  TotalAmt?: number;
  Line?: QBLine[];
}

// Line item types
export interface QBLine {
  Id: string;
  Amount: number;
  Description?: string;
  DetailType: string;
  JournalEntryLineDetail?: {
    PostingType: string;
    AccountRef: QBRef;
    DepartmentRef?: QBRef;
  };
  AccountBasedExpenseLineDetail?: {
    AccountRef: QBRef;
    DepartmentRef?: QBRef;
  };
  DepositLineDetail?: {
    AccountRef?: QBRef;
    DepartmentRef?: QBRef;
  };
  SalesItemLineDetail?: {
    ItemRef?: QBRef;
    Qty?: number;
    UnitPrice?: number;
  };
  ItemBasedExpenseLineDetail?: {
    ItemRef: QBRef;
    Qty?: number;
    UnitPrice?: number;
  };
}

// Journal Entry specific
export interface QBJournalEntry extends QBEntity {
  Line: Array<QBLine & {
    JournalEntryLineDetail: {
      PostingType: string;
      AccountRef: QBRef;
      DepartmentRef?: QBRef;
    };
  }>;
}

// Purchase/Expense specific
export interface QBPurchase extends QBEntity {
  PaymentType: string;
  AccountRef?: QBRef;
  EntityRef?: QBRef & { type?: string };
}

// Bill specific
export interface QBBill extends QBEntity {
  DueDate?: string;
  VendorRef: QBRef;
  APAccountRef?: QBRef;
}

// Deposit specific
export interface QBDeposit extends QBEntity {
  DepositToAccountRef?: QBRef;
}

// Sales Receipt specific
export interface QBSalesReceipt extends QBEntity {
  DepositToAccountRef?: QBRef;
  DepartmentRef?: QBRef;
}

// Payment specific
export interface QBPayment extends QBEntity {
  DepositToAccountRef?: QBRef;
}

// Query response wrapper
export interface QBQueryResponse<T = unknown> {
  QueryResponse?: {
    [key: string]: T[];
  };
}

export interface QBReport {
  Header?: {
    ReportName?: string;
    StartPeriod?: string;
    EndPeriod?: string;
    DateMacro?: string;
    ReportBasis?: string;
    Currency?: string;
    Option?: Array<{ Name: string; Value: string }>;
  };
  Columns?: {
    Column?: Array<{ ColTitle?: string; ColType?: string }>;
  };
  Rows?: {
    Row?: Array<{
      type?: string;
      group?: string;
      Summary?: { ColData?: Array<{ value?: string }> };
      Rows?: { Row?: Array<unknown> };
    }>;
  };
}

// OAuth/token error detection helpers
// intuit-oauth and node-quickbooks throw various error formats for token issues

/**
 * Check if an error indicates an expired or invalid refresh token.
 * This happens when the 100-day refresh token lifetime has elapsed,
 * or when a refresh token has been revoked/invalidated.
 */
export function isRefreshTokenError(error: unknown): boolean {
  const msg = getErrorString(error).toLowerCase();
  return msg.includes('invalid_grant') ||
    msg.includes('refresh token') && (msg.includes('expired') || msg.includes('invalid')) ||
    msg.includes('token has been revoked') ||
    msg.includes('token_expired');
}

/**
 * Check if an error indicates an invalid grant (covers both access and refresh token issues).
 */
export function isInvalidGrantError(error: unknown): boolean {
  const msg = getErrorString(error).toLowerCase();
  return msg.includes('invalid_grant') || msg.includes('invalid grant');
}

/**
 * Check if an error is a CSRF/state mismatch error from the OAuth flow.
 */
export function isCSRFError(error: unknown): boolean {
  const msg = getErrorString(error).toLowerCase();
  return msg.includes('csrf') ||
    msg.includes('state mismatch') ||
    msg.includes('state parameter');
}

/**
 * Convert any error into a searchable string for pattern matching.
 */
function getErrorString(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return `${error.message} ${error.name}`;
  if (typeof error === 'object' && error !== null) {
    try { return JSON.stringify(error); } catch { return String(error); }
  }
  return String(error);
}

export interface TransactionLine {
  date: string;
  type: string;
  txnId: string;
  docNumber?: string;
  lineId: string;
  amount: number;        // Positive = debit, Negative = credit
  description?: string;
  department?: string;
  qboLink: string;
  accountId: string;           // Account ID for this line
  accountName: string;         // Account name (e.g., "4010 Sales" or "Undeposited Funds")
  isMatchingLine: boolean;     // True if this line matched the target account query
}

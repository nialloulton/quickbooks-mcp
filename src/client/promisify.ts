// Promisify helper for node-quickbooks callbacks

import { markWriteIssued } from "./write-barrier.js";
import { captureIntuitTid } from "../utils/logger.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QBCallback<T> = (err: Error | null, result: T, response?: any) => void;

export function promisify<T>(fn: (callback: QBCallback<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result, response) => {
      // Capture intuit_tid from response headers for troubleshooting
      if (response?.headers) {
        const tid = response.headers["intuit_tid"] || response.headers["intuit-tid"];
        if (tid) {
          captureIntuitTid(tid);
        }
      }

      if (err) {
        // Also try to capture tid from error responses
        const errResponse = (err as unknown as Record<string, unknown>)?.response as Record<string, unknown> | undefined;
        if (errResponse?.headers) {
          const headers = errResponse.headers as Record<string, string>;
          const tid = headers["intuit_tid"] || headers["intuit-tid"];
          if (tid) {
            captureIntuitTid(tid);
          }
        }
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * promisify for a call that can change data in QuickBooks — every create,
 * update and delete.
 *
 * Identical to promisify apart from arming the write barrier first, which is
 * what tells the auth-retry dispatcher that this attempt can no longer be
 * replayed. Use it for anything that posts; using plain promisify for a write
 * silently opts that tool back into being retried.
 */
export function promisifyWrite<T>(fn: (callback: (err: Error | null, result: T) => void) => void): Promise<T> {
  markWriteIssued();
  return promisify(fn);
}

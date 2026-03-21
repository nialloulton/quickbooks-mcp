// Promisify helper for node-quickbooks callbacks

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

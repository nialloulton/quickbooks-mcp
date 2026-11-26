// File utilities for report output

import { writeFileSync } from "fs";
import { join, resolve } from "path";
import tmp from "tmp";
import { randomUUID } from "node:crypto";

export function writeInvoicePdf(id: string, pdf: Buffer): string {
  const dir = process.env.QBO_PDF_OUTPUT_DIR || getReportsDir();
  const path = resolve(dir, `invoice-${id}-${randomUUID()}.pdf`);
  writeFileSync(path, pdf, { flag: "wx", mode: 0o600 });
  return path;
}

// Enable automatic cleanup on process exit
tmp.setGracefulCleanup();

// Lazy temp directory — only created on first writeReport() call
let reportsDir: string | null = null;

function getReportsDir(): string {
  if (!reportsDir) {
    const tmpDir = tmp.dirSync({ prefix: "qb-reports-", unsafeCleanup: true });
    reportsDir = tmpDir.name;
  }
  return reportsDir;
}

// Handle signals for graceful cleanup
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

export function writeReport(reportType: string, data: unknown): string {
  const dir = getReportsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${reportType}-${timestamp}.json`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

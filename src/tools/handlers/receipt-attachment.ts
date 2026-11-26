import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import QuickBooks from "node-quickbooks";
import { markWriteIssued, qboRequest } from "../../client/index.js";
import { isHttpMode } from "../../utils/output.js";
import { receiptTargets } from "../../types/receipt.js";

const mimeTypes = new Map([[".pdf", "application/pdf"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".png", "image/png"]]);
const maxBytes = 100_000_000;

interface ReceiptTarget {
  target_type: typeof receiptTargets[number];
  target_id: string;
}

export interface ReceiptArgs extends ReceiptTarget {
  file_path?: string;
  file_name?: string;
  content_base64?: string;
  expected_sha256?: string;
  draft?: boolean;
}

async function readReceipt(args: ReceiptArgs) {
  let bytes: ArrayBuffer;
  let name: string;
  if (args.file_path !== undefined) {
    if (isHttpMode() || args.content_base64 !== undefined || args.file_name !== undefined) {
      throw new Error("Use either a local file_path on stdio, or file_name with content_base64.");
    }
    const sourceDir = process.env.QBO_RECEIPT_DIR || join(homedir(), "Documents", "QuickBooks Receipts");
    const root = await realpath(sourceDir).catch(() => {
      throw new Error("Receipt folder unavailable. Use an existing QBO_RECEIPT_DIR or supply file_name and content_base64.");
    });
    const path = await realpath(resolve(root, args.file_path));
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("Receipt is outside QBO_RECEIPT_DIR.");
    const info = await stat(path);
    if (!info.isFile() || !info.size || info.size > maxBytes) throw new Error("Receipt must be a nonempty file under 100 MB.");
    const blob = await openAsBlob(path);
    if (blob.size !== info.size) throw new Error("Receipt changed while opening it.");
    bytes = await blob.arrayBuffer();
    name = basename(path);
  } else {
    const encoded = args.content_base64;
    if (typeof args.file_name !== "string" || typeof encoded !== "string" || !encoded.length ||
        encoded.length > 4 * Math.ceil(maxBytes / 3) || encoded.length % 4 !== 0) {
      throw new Error("Supply a file_name and valid base64 receipt of at most 100 MB.");
    }
    const decoded = Buffer.from(encoded, "base64");
    if (!decoded.length || decoded.length > maxBytes || decoded.toString("base64") !== encoded) throw new Error("Invalid base64 receipt.");
    bytes = Uint8Array.from(decoded).buffer;
    name = args.file_name;
  }
  if (!name || name.length > 255 || /[\\/\x00-\x1f"<>:|?*]/.test(name)) throw new Error("Invalid receipt filename.");
  const type = mimeTypes.get(extname(name).toLowerCase());
  const data = Buffer.from(bytes);
  const valid = (type === "application/pdf" && data.subarray(0, 5).toString() === "%PDF-") ||
    (type === "image/jpeg" && data.subarray(0, 3).equals(Buffer.from([0xff,0xd8,0xff]))) ||
    (type === "image/png" && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
  if (!type || !valid) throw new Error("Receipt must be a PDF, JPEG or PNG matching its filename.");
  return { name, file: new Blob([bytes], { type }), digest: createHash("sha256").update(data).digest("hex") };
}

async function describeTarget(client: QuickBooks, { target_type: targetType, target_id: id }: ReceiptTarget) {
  if (!receiptTargets.includes(targetType) || typeof id !== "string" || !/^\d+$/.test(id)) throw new Error("Invalid receipt target.");
  const record = await qboRequest<Record<string, { Id?: string; DocNumber?: string; TxnDate?: string }>>(
    client, "GET", `/${targetType.toLowerCase()}/${id}`);
  const target = record[targetType];
  if (target?.Id !== id) throw new Error("QuickBooks did not return the requested receipt target.");
  return `${targetType} ID ${id}` +
    (target.DocNumber ? `, ref ${target.DocNumber}` : "") + (target.TxnDate ? `, dated ${target.TxnDate}` : "");
}

export async function handleCreateReceiptAttachment(client: QuickBooks, args: ReceiptArgs) {
  const { target_type: targetType, target_id: id } = args;
  const { name, file, digest } = await readReceipt(args);
  if (args.expected_sha256 !== undefined && args.expected_sha256 !== digest) throw new Error("Receipt differs from the preview.");
  const summary = `${name} (${file.size} bytes) to ${await describeTarget(client, args)}`;
  if (args.draft !== false) {
    return { content: [{ type: "text" as const, text: `DRAFT - Attach ${summary}\nSHA-256: ${digest}\nUse draft=false and expected_sha256 to upload this file.` }] };
  }
  const metadata = { FileName: name, ContentType: file.type, AttachableRef: [{ EntityRef: { type: targetType, value: id } }] };
  const form = new FormData();
  form.append("file_metadata_01", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.append("file_content_01", file, name);
  // Upload bytes and their transaction link in the same QuickBooks request.
  markWriteIssued();
  const response = await qboRequest<{ AttachableResponse?: Array<{ Fault?: unknown; Attachable?: { Id?: string } }> }>(
    client, "POST", "/upload", form);
  const entry = response.AttachableResponse?.[0];
  if (entry?.Fault) throw { Fault: entry.Fault };
  if (!entry?.Attachable?.Id) throw new Error("No attachment ID returned. Check the transaction before repeating the upload.");
  return { content: [{ type: "text" as const, text: `Attached ${summary}. Attachment ID: ${entry.Attachable.Id}` }] };
}

interface LinkArgs extends ReceiptTarget {
  attachment_id: string;
  expected_sync_token?: string;
  draft?: boolean;
}

interface AttachmentRef {
  EntityRef: { type: string; value: string };
  IncludeOnSend?: boolean;
}

interface Attachment {
  Id: string;
  SyncToken: string;
  FileName?: string;
  ContentType?: string;
  AttachableRef?: AttachmentRef[];
}

function references(file: Attachment): AttachmentRef[] {
  if (file.AttachableRef === undefined) return [];
  if (!Array.isArray(file.AttachableRef) || file.AttachableRef.some(ref =>
    typeof ref?.EntityRef?.type !== "string" || typeof ref.EntityRef.value !== "string")) {
    throw new Error("QuickBooks returned unreadable attachment references. Inspect the attachment before editing.");
  }
  return file.AttachableRef;
}

function sameTarget(a: AttachmentRef, b: AttachmentRef) {
  return a.EntityRef.value === b.EntityRef.value && a.EntityRef.type.toLowerCase() === b.EntityRef.type.toLowerCase();
}

export async function handleLinkReceiptAttachment(client: QuickBooks, args: LinkArgs) {
  const id = args.attachment_id;
  if (typeof id !== "string" || !/^\d+$/.test(id)) throw new Error("Invalid attachment ID.");
  const target = await describeTarget(client, args);
  const readFile = async () => (await qboRequest<{ Attachable?: Attachment }>(client, "GET", `/attachable/${id}`)).Attachable;
  const file = await readFile();
  if (file?.Id !== id || !file.FileName || typeof file.SyncToken !== "string" || !file.SyncToken) {
    throw new Error("QuickBooks did not return the requested uploaded file with its revision.");
  }
  const existing = references(file);
  const added = { EntityRef: { type: args.target_type, value: args.target_id }, IncludeOnSend: false };
  const summary = `${file.FileName} (attachment ${id}) to ${target}`;
  const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
  if (existing.some(ref => sameTarget(ref, added))) return reply(`Already linked: ${summary}.`);
  if (args.draft !== false) {
    const links = existing.map(ref => `${ref.EntityRef.type} ${ref.EntityRef.value}`).join(", ") || "none";
    return reply(`DRAFT - Link ${summary}. Existing links: ${links}.\nUse draft=false and expected_sync_token="${file.SyncToken}" to apply this revision.`);
  }
  if (args.expected_sync_token !== file.SyncToken) throw new Error("Preview this attachment again and supply its current expected_sync_token.");
  const refs = [...existing, added];
  const update = { Id: id, SyncToken: file.SyncToken, sparse: true, FileName: file.FileName, ContentType: file.ContentType, AttachableRef: refs };
  markWriteIssued();
  await qboRequest(client, "POST", "/attachable?operation=update", update);
  const saved = await readFile();
  const confirmed = saved?.Id === id ? references(saved) : [];
  if (!refs.every(ref => confirmed.some(actual => sameTarget(ref, actual) &&
      (actual.IncludeOnSend ?? false) === (ref.IncludeOnSend ?? false)))) {
    throw new Error("Could not verify the attachment links after the update. Inspect the existing attachment before retrying.");
  }
  return reply(`Linked ${summary}. Verified ${refs.length} transaction reference(s).`);
}

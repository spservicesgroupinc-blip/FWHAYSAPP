/**
 * A deliberately unconnected protocol for private files. The server must
 * authorize each operation, own the object path, reserve immutable uploads,
 * verify bytes before finalizing, and resolve ambiguous upload outcomes. No
 * current backend implements this contract; do not attach it to the app yet.
 */
export type PrivateFileSpec = {
  parentId: string;
  fileId: string;
  name: string;
  mimeType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
} & (
  | { parentType: "workspace"; kind: string; inputFingerprint: string; templateVersion: number }
  | { parentType: "request"; kind: "estimate" | "quote" | "photo" | "document" }
);

export type PrivateFileIdentity = PrivateFileSpec & { mutationId: string; size: number; sha256: string };
export type PrivateFileReceipt = PrivateFileIdentity;

export type FileReservation =
  | { state: "upload"; ticket: string; identity: PrivateFileIdentity }
  | { state: "finalize"; ticket: string; identity: PrivateFileIdentity }
  | { state: "complete"; receipt: PrivateFileReceipt };

export interface PrivateFilePort {
  /** Server resolves retries and reserves the immutable object for this identity. */
  reserve(identity: PrivateFileIdentity): Promise<FileReservation>;
  /** Server-authorized upload; must not overwrite an existing object. */
  upload(ticket: string, data: Blob): Promise<void>;
  /** Server must verify object bytes, parent permission, and identity atomically. */
  finalize(ticket: string): Promise<PrivateFileReceipt>;
  /** Server checks current parent access before returning metadata and bytes. */
  download(parentType: PrivateFileSpec["parentType"], parentId: string, fileId: string): Promise<{ receipt: PrivateFileReceipt; data: Blob }>;
}

export class PrivateFileError extends Error {
  constructor(message: string) { super(message); this.name = "PrivateFileError"; }
}

const MAX_SIZE = 15 * 1024 * 1024;

function sameIdentity(a: PrivateFileIdentity, b: PrivateFileIdentity): boolean {
  if (a.parentType !== b.parentType || a.parentId !== b.parentId || a.fileId !== b.fileId || a.mutationId !== b.mutationId ||
      a.name !== b.name || a.mimeType !== b.mimeType || a.kind !== b.kind || a.size !== b.size || a.sha256 !== b.sha256) return false;
  if (a.parentType === "workspace" && b.parentType === "workspace") {
    return a.inputFingerprint === b.inputFingerprint && a.templateVersion === b.templateVersion;
  }
  return a.parentType === "request" && b.parentType === "request";
}

function validSpec(spec: PrivateFileSpec): boolean {
  if (!spec.parentId || !spec.fileId || !spec.name.trim() || spec.name.length > 300) return false;
  if (spec.parentType === "workspace") return spec.mimeType === "application/pdf" && !!spec.kind.trim() && !!spec.inputFingerprint && Number.isInteger(spec.templateVersion) && spec.templateVersion > 0;
  return ["estimate", "quote", "photo", "document"].includes(spec.kind);
}

async function inspectFile(data: Blob, mimeType: PrivateFileSpec["mimeType"]): Promise<{ size: number; sha256: string }> {
  if (data.size < 1 || data.size > MAX_SIZE) throw new PrivateFileError("Choose a supported file up to 15 MB.");
  const bytes = new Uint8Array(await data.arrayBuffer());
  const signature = mimeType === "application/pdf" ? [37, 80, 68, 70, 45].every((v, i) => bytes[i] === v)
    : mimeType === "image/jpeg" ? [255, 216, 255].every((v, i) => bytes[i] === v)
    : mimeType === "image/png" ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    : mimeType === "image/webp" && [82, 73, 70, 70].every((v, i) => bytes[i] === v) && [87, 69, 66, 80].every((v, i) => bytes[i + 8] === v);
  if (!signature) throw new PrivateFileError("The file content does not match its type.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { size: bytes.length, sha256: Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("") };
}

/** Persist spec, bytes and mutationId together and reuse all three on retry. */
export async function uploadPrivateFile(port: PrivateFilePort, spec: PrivateFileSpec, data: Blob, mutationId: string): Promise<PrivateFileReceipt> {
  if (!validSpec(spec) || !mutationId) throw new PrivateFileError("File details and a retry identifier are required.");
  const identity: PrivateFileIdentity = { ...spec, mutationId, ...await inspectFile(data, spec.mimeType) };
  const reservation = await port.reserve(identity);
  if (reservation.state === "complete") {
    if (!sameIdentity(identity, reservation.receipt)) throw new PrivateFileError("The server returned a different file confirmation.");
    return reservation.receipt;
  }
  if (!reservation.ticket || !sameIdentity(identity, reservation.identity)) throw new PrivateFileError("The server returned a different file reservation.");
  if (reservation.state === "upload") await port.upload(reservation.ticket, data);
  const receipt = await port.finalize(reservation.ticket);
  if (!sameIdentity(identity, receipt)) throw new PrivateFileError("The server did not confirm the expected file.");
  return receipt;
}

export async function downloadPrivateFile(port: PrivateFilePort, parentType: PrivateFileSpec["parentType"], parentId: string, fileId: string): Promise<{ name: string; blob: Blob }> {
  if (!parentId || !fileId) throw new PrivateFileError("A parent and file identifier are required.");
  const { receipt, data } = await port.download(parentType, parentId, fileId);
  if (!receipt || receipt.parentType !== parentType || receipt.parentId !== parentId || receipt.fileId !== fileId || !validSpec(receipt)) {
    throw new PrivateFileError("The server returned a file for a different record.");
  }
  const actual = await inspectFile(data, receipt.mimeType);
  if (actual.size !== receipt.size || actual.sha256 !== receipt.sha256) throw new PrivateFileError("The downloaded file failed its integrity check.");
  return { name: receipt.name, blob: new Blob([data], { type: receipt.mimeType }) };
}

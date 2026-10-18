// Kept apart from the Storage browser: the shell uses it, and the browser (a lazy panel) must not ride along in the initial chunk.

/** Triggers a browser download of `bytes` (UI edge; no storage access on the render path). */
export function downloadBytes(bytes: Uint8Array, filename: string, type = "application/vnd.sqlite3"): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Convert a `File` (or `Blob`) to a base64 string suitable for shipping
 * across the Tauri IPC boundary.
 *
 * Uses the browser's native `FileReader.readAsDataURL` — implemented in
 * compiled engine code — instead of the obvious-looking JS pattern of
 * building a binary string with `String.fromCharCode` in a loop and
 * calling `btoa` on it. For a multi-MB audio or video file that loop
 * runs millions of iterations, allocating an intermediate JS string the
 * size of the file; the page goes unresponsive (or, on some webview
 * builds, the loop throws silently mid-way), and the resulting "drop
 * did nothing" symptom is the same. The native reader handles the same
 * conversion in one call without the intermediate string.
 *
 * The data URL prefix (`data:<mime>;base64,`) is stripped before return,
 * matching the format that `copy_to_attachments` (Rust) expects.
 */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

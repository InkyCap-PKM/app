/**
 * Convert a `File` (or `Blob`) to base64 for sending over IPC.
 *
 * Uses the native `FileReader.readAsDataURL` rather than building a string with
 * `String.fromCharCode` in a loop for `btoa`, which for a large audio or video
 * file makes the page unresponsive (or fails silently).
 *
 * The `data:<mime>;base64,` prefix is removed, as `copy_bytes_into_notebox`
 * (Rust) expects.
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

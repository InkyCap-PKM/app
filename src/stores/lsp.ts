import { errorText } from "../lib/errors";
import { createSignal } from "solid-js";
import { LspClient, filePathToUri } from "../editor/lsp";

const [lspReady, setLspReady] = createSignal(false);
const [lspError, setLspError] = createSignal<string | null>(null);

let client: LspClient | null = null;

export function getLspClient(): LspClient | null {
  return lspReady() ? client : null;
}

export async function startLsp(noteboxPath: string): Promise<void> {
  await stopLsp();

  client = new LspClient();
  client.setErrorHandler(routeLspLog);

  try {
    await client.start(noteboxPath);
    setLspReady(true);
    setLspError(null);
    // Diagnostic only; no path logged (local-first privacy — paths don't go to
    // the console either). console.debug so it's filterable, not normal noise.
    console.debug("[LSP] Tinymist initialized");
  } catch (err) {
    const msg = errorText(err);
    console.error("[LSP] Failed to start Tinymist:", msg);
    setLspError(msg);
    client = null;
  }
}

// tinymist logs to stderr as
//   [<timestamp> <LEVEL> <target>] <message>
// with LEVEL ERROR / WARN / INFO / DEBUG / TRACE. Each line goes to the
// matching console level: errors and warnings stay visible, INFO/DEBUG/TRACE go
// to `console.debug` (shown only at the devtools "Verbose" level). Our own
// transport failures (process error, non-zero exit) have no level and are shown
// as errors.
function routeLspLog(raw: string) {
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const tag = "[LSP/tinymist]";
    if (
      text.startsWith("Tinymist process error") ||
      text.startsWith("Tinymist exited with code")
    ) {
      console.error(tag, text);
      continue;
    }
    const level = text.match(/\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/)?.[1];
    if (level === "ERROR") console.error(tag, text);
    else if (level === "WARN") console.warn(tag, text);
    else console.debug(tag, text); // INFO / DEBUG / TRACE / continuation lines
  }
}

export async function stopLsp(): Promise<void> {
  if (client) {
    try {
      await client.stop();
    } catch {
      // Best-effort cleanup
    }
    client = null;
  }
  setLspReady(false);
  setLspError(null);
}

export { lspReady, lspError };

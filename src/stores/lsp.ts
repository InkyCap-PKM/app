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
    console.log("[LSP] Tinymist initialized, ready for", noteboxPath);
  } catch (err) {
    const msg = errorText(err);
    console.error("[LSP] Failed to start Tinymist:", msg);
    setLspError(msg);
    client = null;
  }
}

// tinymist writes its operational logs to stderr in the form
//   [<timestamp> <LEVEL> <target>] <message>
// where LEVEL is ERROR / WARN / INFO / DEBUG / TRACE. The whole stream used to
// be forwarded at `console.warn`, so routine INFO chatter (server startup,
// "did open file", a note that doesn't compile cleanly for the LSP, …) showed
// up as a wall of warnings and buried any real problem. Route each line to the
// matching console level instead: errors/warnings stay visible, and the routine
// INFO/DEBUG/TRACE stream drops to `console.debug` (hidden unless the devtools
// "Verbose" level is on). Our own transport-level failures (process error,
// non-zero exit) carry no level token and are surfaced as errors.
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

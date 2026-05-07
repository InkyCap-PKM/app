import { createSignal } from "solid-js";
import { LspClient, filePathToUri } from "../editor/lsp";

const [lspReady, setLspReady] = createSignal(false);
const [lspError, setLspError] = createSignal<string | null>(null);

let client: LspClient | null = null;

export function getLspClient(): LspClient | null {
  return lspReady() ? client : null;
}

export async function startLsp(vaultPath: string): Promise<void> {
  await stopLsp();

  client = new LspClient();
  client.setErrorHandler((err) => {
    console.warn("[LSP/tinymist]", err);
  });

  try {
    await client.start(vaultPath);
    setLspReady(true);
    setLspError(null);
    console.log("[LSP] Tinymist initialized, ready for", vaultPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[LSP] Failed to start Tinymist:", msg);
    setLspError(msg);
    client = null;
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

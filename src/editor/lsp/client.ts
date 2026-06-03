import { LspTransport, type LspMessage } from "./transport";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  message: string;
  source?: string;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  insertTextFormat?: number; // 1=PlainText, 2=Snippet
  textEdit?: {
    range: LspRange;
    newText: string;
  };
  sortText?: string;
  filterText?: string;
}

export interface LspHoverResult {
  contents: string | { kind: string; value: string } | Array<string | { language: string; value: string }>;
  range?: LspRange;
}

export interface LspServerCapabilities {
  completionProvider?: {
    triggerCharacters?: string[];
    resolveProvider?: boolean;
  };
  hoverProvider?: boolean;
  textDocumentSync?: number | { openClose?: boolean; change?: number };
  diagnosticProvider?: unknown;
}

type DiagnosticsHandler = (uri: string, diagnostics: LspDiagnostic[]) => void;

export class LspClient {
  private transport = new LspTransport();
  private capabilities: LspServerCapabilities = {};
  private initialized = false;
  private rootUri: string | null = null;
  private openDocuments = new Map<string, number>(); // uri → version
  private onDiagnostics: DiagnosticsHandler = () => {};

  setDiagnosticsHandler(handler: DiagnosticsHandler) {
    this.onDiagnostics = handler;
  }

  setErrorHandler(handler: (err: string) => void) {
    this.transport.setErrorHandler(handler);
  }

  async start(noteboxPath: string): Promise<void> {
    if (this.initialized) return;

    this.rootUri = pathToUri(noteboxPath);

    this.transport.setNotificationHandler((msg) => this.handleNotification(msg));
    await this.transport.spawn(["lsp"]);

    // Diagnostic only; rootUri (a filesystem path) is not logged — local-first
    // privacy keeps paths off the console. console.debug so it's filterable.
    console.debug("[LSP] Sending initialize request");
    const initResult = await this.transport.request("initialize", {
      processId: null,
      capabilities: {
        textDocument: {
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
            },
          },
          hover: {
            contentFormat: ["markdown", "plaintext"],
          },
          publishDiagnostics: {
            relatedInformation: true,
          },
          synchronization: {
            didSave: true,
          },
        },
        workspace: {
          workspaceFolders: true,
        },
      },
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: "notebox" }],
    });

    if (initResult.result) {
      this.capabilities = (initResult.result as { capabilities: LspServerCapabilities }).capabilities ?? {};
      console.debug("[LSP] Server capabilities received");
    } else if (initResult.error) {
      console.error("[LSP] Initialize error:", initResult.error);
    }

    await this.transport.notify("initialized", {});
    this.initialized = true;
    console.debug("[LSP] Handshake complete");
  }

  async stop(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    this.openDocuments.clear();
    await this.transport.shutdown();
  }

  isRunning(): boolean {
    return this.initialized && this.transport.isRunning();
  }

  getCapabilities(): LspServerCapabilities {
    return this.capabilities;
  }

  async openDocument(uri: string, text: string): Promise<void> {
    if (!this.initialized) return;
    this.openDocuments.set(uri, 0);
    await this.transport.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "typst",
        version: 0,
        text,
      },
    });
  }

  async changeDocument(uri: string, text: string): Promise<void> {
    if (!this.initialized || !this.openDocuments.has(uri)) return;
    const version = (this.openDocuments.get(uri) ?? 0) + 1;
    this.openDocuments.set(uri, version);
    await this.transport.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  async closeDocument(uri: string): Promise<void> {
    if (!this.initialized || !this.openDocuments.has(uri)) return;
    this.openDocuments.delete(uri);
    await this.transport.notify("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  async completion(uri: string, position: LspPosition): Promise<LspCompletionItem[]> {
    if (!this.initialized) return [];
    const result = await this.transport.request("textDocument/completion", {
      textDocument: { uri },
      position,
    });
    if (result.error) return [];
    const data = result.result as { items?: LspCompletionItem[] } | LspCompletionItem[] | null;
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.items ?? [];
  }

  async hover(uri: string, position: LspPosition): Promise<LspHoverResult | null> {
    if (!this.initialized) return null;
    const result = await this.transport.request("textDocument/hover", {
      textDocument: { uri },
      position,
    });
    if (result.error || !result.result) return null;
    return result.result as LspHoverResult;
  }

  async formatting(uri: string): Promise<Array<{ range: LspRange; newText: string }> | null> {
    if (!this.initialized) return null;
    const result = await this.transport.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    if (result.error || !result.result) return null;
    return result.result as Array<{ range: LspRange; newText: string }>;
  }

  private handleNotification(msg: LspMessage) {
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
      this.onDiagnostics(params.uri, params.diagnostics);
    }
  }
}

function pathToUri(path: string): string {
  if (path.startsWith("file://")) return path;
  const normalized = path.replace(/\\/g, "/");
  // Encode each path segment individually so `/` stays literal
  const encoded = normalized
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  if (encoded.startsWith("/")) {
    return `file://${encoded}`;
  }
  return `file:///${encoded}`;
}

export function filePathToUri(path: string): string {
  return pathToUri(path);
}

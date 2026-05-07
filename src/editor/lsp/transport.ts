import { Command, type Child } from "@tauri-apps/plugin-shell";

export interface LspMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type MessageHandler = (msg: LspMessage) => void;
type ErrorHandler = (err: string) => void;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Tauri's shell plugin delivers "raw" payloads as JSON-serialized arrays,
// which arrive in JS as plain number[] — not Uint8Array. This normalizer
// handles both forms so the rest of the transport can work with Uint8Array.
function toBytes(raw: Uint8Array | number[] | ArrayLike<number>): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  return new Uint8Array(raw);
}

export class LspTransport {
  private child: Child | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (msg: LspMessage) => void; reject: (err: Error) => void }>();
  private onNotification: MessageHandler = () => {};
  private onError: ErrorHandler = () => {};
  private buffer = new Uint8Array(0);
  private expectedLength: number | null = null;

  setNotificationHandler(handler: MessageHandler) {
    this.onNotification = handler;
  }

  setErrorHandler(handler: ErrorHandler) {
    this.onError = handler;
  }

  async spawn(args: string[]): Promise<void> {
    // Raw encoding delivers stdout/stderr as byte chunks without
    // line-buffering. This is required because LSP response bodies
    // have no trailing newline — string mode would hold the body
    // in Tauri's internal buffer indefinitely.
    const command = Command.sidecar("binaries/tinymist", args, {
      encoding: "raw",
    });

    command.stdout.on("data", (raw: unknown) => {
      this.onStdoutChunk(toBytes(raw as Uint8Array | number[]));
    });

    command.stderr.on("data", (raw: unknown) => {
      const text = decoder.decode(toBytes(raw as Uint8Array | number[])).trim();
      if (text) this.onError(text);
    });

    command.on("error", (err) => {
      this.onError(`Tinymist process error: ${err}`);
    });

    command.on("close", (payload) => {
      this.child = null;
      if (payload.code !== 0 && payload.code !== null) {
        this.onError(`Tinymist exited with code ${payload.code}`);
      }
    });

    this.child = await command.spawn();
  }

  async request(method: string, params?: unknown, timeoutMs = 10000): Promise<LspMessage> {
    const id = ++this.nextId;
    const msg: LspMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.send(msg).catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const msg: LspMessage = { jsonrpc: "2.0", method, params };
    await this.send(msg);
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request("shutdown");
      await this.notify("exit");
    } catch {
      // Best-effort
    }
    try {
      await this.child.kill();
    } catch {
      // Already dead
    }
    this.child = null;
    this.pending.clear();
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  private async send(msg: LspMessage): Promise<void> {
    if (!this.child) throw new Error("LSP transport not connected");
    const body = JSON.stringify(msg);
    const bodyBytes = encoder.encode(body);
    const headerStr = `Content-Length: ${bodyBytes.length}\r\n\r\n`;
    const headerBytes = encoder.encode(headerStr);
    // Combine header + body into a single write to avoid partial frames
    const frame = new Uint8Array(headerBytes.length + bodyBytes.length);
    frame.set(headerBytes);
    frame.set(bodyBytes, headerBytes.length);
    await this.child.write(frame);
  }

  private onStdoutChunk(chunk: Uint8Array) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    this.drainBuffer();
  }

  private drainBuffer() {
    while (true) {
      if (this.expectedLength === null) {
        const sepIndex = this.findDoubleCrlf();
        if (sepIndex === -1) return;

        const header = decoder.decode(this.buffer.slice(0, sepIndex));
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          this.buffer = this.buffer.slice(sepIndex + 4);
          continue;
        }
        this.expectedLength = parseInt(match[1], 10);
        this.buffer = this.buffer.slice(sepIndex + 4);
      }

      if (this.buffer.length < this.expectedLength) return;

      const bodyStr = decoder.decode(this.buffer.slice(0, this.expectedLength));
      this.buffer = this.buffer.slice(this.expectedLength);
      this.expectedLength = null;

      let msg: LspMessage;
      try {
        msg = JSON.parse(bodyStr);
      } catch {
        continue;
      }

      this.dispatchMessage(msg);
    }
  }

  private findDoubleCrlf(): number {
    for (let i = 0; i <= this.buffer.length - 4; i++) {
      if (
        this.buffer[i] === 0x0d &&
        this.buffer[i + 1] === 0x0a &&
        this.buffer[i + 2] === 0x0d &&
        this.buffer[i + 3] === 0x0a
      ) {
        return i;
      }
    }
    return -1;
  }

  private dispatchMessage(msg: LspMessage) {
    if (msg.id !== undefined && this.pending.has(msg.id as number)) {
      const { resolve } = this.pending.get(msg.id as number)!;
      this.pending.delete(msg.id as number);
      resolve(msg);
    } else {
      this.onNotification(msg);
    }
  }
}

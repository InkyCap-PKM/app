import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-shell", () => ({ Command: class {} }));

import { LspClient, type LspDiagnostic } from "./client";

/** Feed the client a diagnostics notification as if the server sent it. */
function publish(client: LspClient, uri: string, diagnostics: LspDiagnostic[]) {
  (client as unknown as { handleNotification(msg: unknown): void }).handleNotification({
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics },
  });
}

const warning: LspDiagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
  severity: 2,
  message: "no text within stars",
};

describe("LspClient diagnostics subscriptions", () => {
  it("delivers each document's diagnostics only to that document's editors", () => {
    const client = new LspClient();
    const a = vi.fn();
    const b = vi.fn();
    client.subscribeDiagnostics("file:///nb/a.typ", a);
    client.subscribeDiagnostics("file:///nb/b.typ", b);
    publish(client, "file:///nb/a.typ", [warning]);
    expect(a).toHaveBeenCalledWith([warning]);
    expect(b).not.toHaveBeenCalled();
  });

  it("keeps other editors subscribed when one editor unsubscribes", () => {
    const client = new LspClient();
    const a = vi.fn();
    const b = vi.fn();
    client.subscribeDiagnostics("file:///nb/a.typ", a);
    const stopB = client.subscribeDiagnostics("file:///nb/b.typ", b);
    stopB();
    publish(client, "file:///nb/a.typ", [warning]);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("hands the latest diagnostics to an editor that subscribes after they arrive", () => {
    const client = new LspClient();
    publish(client, "file:///nb/a.typ", [warning]);
    const late = vi.fn();
    client.subscribeDiagnostics("file:///nb/a.typ", late);
    expect(late).toHaveBeenCalledWith([warning]);
  });

  it("matches URIs that differ only in percent-encoding", () => {
    const client = new LspClient();
    const listener = vi.fn();
    client.subscribeDiagnostics("file:///Code%20Projects/a.typ", listener);
    publish(client, "file:///Code Projects/a.typ", [warning]);
    expect(listener).toHaveBeenCalledWith([warning]);
  });
});

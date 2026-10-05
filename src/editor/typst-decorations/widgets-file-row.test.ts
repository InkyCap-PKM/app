import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../lib/ipc", () => ({
  readMediaBytes: vi.fn(),
  readEmbedBytes: vi.fn(),
  resolveEmbedPath: vi.fn(),
}));

import type { EditorView } from "@codemirror/view";
import * as ipc from "../../lib/ipc";
import { setLocale, DEFAULT_LOCALE } from "../../lib/i18n";
import { ImageBlockWidget, MediaBlockWidget } from "./widgets";

// Without a pill the widgets never touch the view.
const view = {} as EditorView;

/** Render a widget into the page and let its file load settle. */
async function render(widget: { toDOM(view: EditorView): HTMLElement }): Promise<HTMLElement> {
  const dom = widget.toDOM(view);
  document.body.appendChild(dom);
  await new Promise((r) => setTimeout(r, 0));
  return dom;
}

const opener = (dom: HTMLElement) => dom.querySelector<HTMLButtonElement>(".cm-typst-file-open");

afterEach(() => {
  document.body.innerHTML = "";
  vi.mocked(ipc.readMediaBytes).mockReset();
});

describe("embeds that can't be shown in the note", () => {
  setLocale(DEFAULT_LOCALE);

  it("offer the default app for a video too large to play here", async () => {
    vi.mocked(ipc.readMediaBytes).mockRejectedValue({
      code: "file-too-large-to-show",
      message: "too large",
      detail: "900 MB",
    });
    const dom = await render(new MediaBlockWidget("video", "/Assets/big.mp4", 0, false));

    expect(opener(dom)?.title).toBe("Open in default app");
    expect(dom.textContent).toContain("/Assets/big.mp4");
  });

  it("keep just the path for a file that isn't there", async () => {
    vi.mocked(ipc.readMediaBytes).mockRejectedValue({
      code: "invalid-path",
      message: "Not a file",
      detail: "/Assets/gone.mp4",
    });
    const dom = await render(new MediaBlockWidget("video", "/Assets/gone.mp4", 0, false));

    expect(opener(dom)).toBeNull();
  });

  it("offer the viewer for a PDF image, without loading it", async () => {
    const dom = await render(new ImageBlockWidget("/Assets/paper.pdf", 0, false));

    expect(opener(dom)?.title).toBe("Open PDF in a new tab");
    expect(ipc.readEmbedBytes).not.toHaveBeenCalled();
  });
});

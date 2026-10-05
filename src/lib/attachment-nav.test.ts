import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("./ipc", () => ({
  resolveEmbedPath: vi.fn(),
  showInExplorer: vi.fn(),
}));
vi.mock("../stores/toasts", () => ({ toastError: vi.fn() }));
vi.mock("../stores/tabs", () => ({ openTab: vi.fn() }));

import * as ipc from "./ipc";
import { toastError } from "../stores/toasts";
import { openTab } from "../stores/tabs";
import { setLocale, DEFAULT_LOCALE } from "./i18n";
import { REVEAL_IN_FILE_TREE_EVENT } from "./file-tree-reveal";
import { openAttachmentInTab, showAttachmentContextMenu } from "./attachment-nav";

const resolveEmbedPath = vi.mocked(ipc.resolveEmbedPath);
const showInExplorer = vi.mocked(ipc.showInExplorer);

const items = () => [...document.querySelectorAll<HTMLButtonElement>(".context-menu__item")];
const labels = () => items().map((i) => i.textContent);

beforeEach(() => {
  setLocale(DEFAULT_LOCALE);
  vi.clearAllMocks();
});

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.body.innerHTML = "";
});

describe("showAttachmentContextMenu", () => {
  it("offers to open a viewable attachment and both find-this-file actions", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/fig.png");
    await showAttachmentContextMenu(5, 5, "/Assets/fig.png");
    expect(resolveEmbedPath).toHaveBeenCalledWith("/Assets/fig.png");
    expect(labels()).toEqual([
      "Open",
      "Open in new tab",
      "Open in default app",
      "Show in file tree",
      "Show in system file manager",
    ]);
  });

  it("opens the resolved file in place of the current tab", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/fig.png");
    await showAttachmentContextMenu(5, 5, "fig.png");
    items()[0].click();
    expect(openTab).toHaveBeenCalledWith({
      type: "attachment",
      title: "fig.png",
      path: "C:/box/Assets/fig.png",
    });
  });

  it("opens the resolved file in a new attachment tab", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/fig.png");
    await showAttachmentContextMenu(5, 5, "fig.png");
    items()[1].click();
    expect(openTab).toHaveBeenCalledWith(
      { type: "attachment", title: "fig.png", path: "C:/box/Assets/fig.png" },
      { forceNewTab: true, newTabAction: true },
    );
  });

  it("leaves out the open-in-tab action for a file the app has no view for", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/refs.bib");
    await showAttachmentContextMenu(5, 5, "/refs.bib");
    expect(labels()).toEqual([
      "Open in default app",
      "Show in file tree",
      "Show in system file manager",
    ]);
  });

  it("opens a PDF from its open button in a tab brought to the front", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/paper.pdf");
    await openAttachmentInTab("/Assets/paper.pdf");
    expect(openTab).toHaveBeenCalledWith(
      { type: "attachment", title: "paper.pdf", path: "C:/box/Assets/paper.pdf" },
      { forceNewTab: true, newTabAction: false },
    );
  });

  it("reveals the resolved path (not the written one) in the file tree", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/fig.png");
    const revealed: string[] = [];
    const onReveal = (e: Event) => revealed.push((e as CustomEvent<string>).detail);
    document.addEventListener(REVEAL_IN_FILE_TREE_EVENT, onReveal);
    try {
      await showAttachmentContextMenu(5, 5, "fig.png");
      items()[3].click();
    } finally {
      document.removeEventListener(REVEAL_IN_FILE_TREE_EVENT, onReveal);
    }
    expect(revealed).toEqual(["C:/box/Assets/fig.png"]);
  });

  it("hands the resolved path to the system file manager", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/fig.png");
    showInExplorer.mockResolvedValue();
    await showAttachmentContextMenu(5, 5, "fig.png");
    items()[4].click();
    await vi.waitFor(() => expect(showInExplorer).toHaveBeenCalledWith("C:/box/Assets/fig.png"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reports a file-manager failure as a toast", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/fig.png");
    showInExplorer.mockRejectedValue(new Error("nope"));
    await showAttachmentContextMenu(5, 5, "fig.png");
    items()[4].click();
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledOnce());
  });

  it("explains itself instead of offering actions when the file is not in the notebox", async () => {
    resolveEmbedPath.mockResolvedValue(null);
    await showAttachmentContextMenu(5, 5, "missing.png");
    expect(items()).toEqual([]);
    expect(document.querySelector(".context-menu__hint")?.textContent).toBe(
      "Attachment not found in this notebox",
    );
  });

  it("treats a resolver error like an unresolved file", async () => {
    resolveEmbedPath.mockRejectedValue(new Error("notebox not open"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await showAttachmentContextMenu(5, 5, "missing.png");
    } finally {
      quiet.mockRestore();
    }
    expect(items()).toEqual([]);
    expect(document.querySelector(".context-menu__hint")).not.toBeNull();
  });
});

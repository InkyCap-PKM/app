import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("./ipc", () => ({
  resolveEmbedPath: vi.fn(),
  showInExplorer: vi.fn(),
}));
vi.mock("../stores/toasts", () => ({ toastError: vi.fn() }));

import * as ipc from "./ipc";
import { toastError } from "../stores/toasts";
import { setLocale, DEFAULT_LOCALE } from "./i18n";
import { REVEAL_IN_FILE_TREE_EVENT } from "./file-tree-reveal";
import { showAttachmentContextMenu } from "./attachment-nav";

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
  it("offers both find-this-file actions for an attachment in the notebox", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/fig.png");
    await showAttachmentContextMenu(5, 5, "/Assets/fig.png");
    expect(resolveEmbedPath).toHaveBeenCalledWith("/Assets/fig.png");
    expect(labels()).toEqual(["Show in file tree", "Show in system file manager"]);
  });

  it("reveals the resolved path (not the written one) in the file tree", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/fig.png");
    const revealed: string[] = [];
    const onReveal = (e: Event) => revealed.push((e as CustomEvent<string>).detail);
    document.addEventListener(REVEAL_IN_FILE_TREE_EVENT, onReveal);
    try {
      await showAttachmentContextMenu(5, 5, "fig.png");
      items()[0].click();
    } finally {
      document.removeEventListener(REVEAL_IN_FILE_TREE_EVENT, onReveal);
    }
    expect(revealed).toEqual(["C:/box/Assets/fig.png"]);
  });

  it("hands the resolved path to the system file manager", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/fig.png");
    showInExplorer.mockResolvedValue();
    await showAttachmentContextMenu(5, 5, "fig.png");
    items()[1].click();
    await vi.waitFor(() => expect(showInExplorer).toHaveBeenCalledWith("C:/box/Assets/fig.png"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reports a file-manager failure as a toast", async () => {
    resolveEmbedPath.mockResolvedValue("C:/box/Assets/fig.png");
    showInExplorer.mockRejectedValue(new Error("nope"));
    await showAttachmentContextMenu(5, 5, "fig.png");
    items()[1].click();
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

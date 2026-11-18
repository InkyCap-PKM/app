import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render } from "solid-js/web";
import SourceReferenceSection from "./SourceReferenceSection";
import type { SourceReference } from "../lib/types";

// A literature note's References tab shows its own reference, formatted in the
// citation style, and copies it as formatted Typst.

const getSource = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  getNoteSourceReference: getSource,
}));
vi.mock("../stores/toasts", () => ({ showToast: toast }));

const OTLET: SourceReference = {
  key: "otlet1934",
  found: true,
  title: "Traité de documentation",
  formatted: [
    { text: "Otlet, Paul. 1934. ", italic: false, bold: false, small_caps: false },
    { text: "Traité de documentation", italic: true, bold: false, small_caps: false },
    { text: ". Brussels.", italic: false, bold: false, small_caps: false },
  ],
  markup: "Otlet, Paul. 1934. _Traité de documentation_. Brussels.",
};

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  getSource.mockReset();
  toast.mockReset();
});

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

async function mount(path: string | undefined) {
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <SourceReferenceSection path={path} />, host);
  await vi.waitFor(() => expect(getSource).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
}

describe("SourceReferenceSection", () => {
  it("shows the formatted reference, keeping its italics", async () => {
    getSource.mockResolvedValue(OTLET);
    await mount("/nb/Otlet.typ");
    const entry = host!.querySelector(".source-reference")!;
    expect(entry.textContent).toBe("Otlet, Paul. 1934. Traité de documentation. Brussels.");
    expect(entry.querySelector(".source-reference__italic")?.textContent).toBe(
      "Traité de documentation",
    );
  });

  it("copies the reference as formatted Typst", async () => {
    getSource.mockResolvedValue(OTLET);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount("/nb/Otlet.typ");
    host!.querySelector<HTMLButtonElement>(".right-panel__header-actions button")!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(OTLET.markup));
  });

  it("says when the source isn't in the bibliography", async () => {
    getSource.mockResolvedValue({ ...OTLET, found: false, formatted: [], markup: "" });
    await mount("/nb/Otlet.typ");
    expect(host!.querySelector(".source-reference")).toBeNull();
    expect(host!.textContent).toContain("@otlet1934");
    expect(host!.querySelector(".right-panel__header-actions")).toBeNull();
  });

  it("shows nothing for a note without a source reference", async () => {
    getSource.mockResolvedValue(null);
    await mount("/nb/Plain.typ");
    expect(host!.textContent).toBe("");
  });
});

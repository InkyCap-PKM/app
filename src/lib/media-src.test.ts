import { describe, it, expect, vi } from "vitest";

vi.mock("./ipc", () => ({}));

import { attachmentViewKind } from "./media-src";

describe("attachmentViewKind", () => {
  it("sorts viewable files by kind, ignoring extension case", () => {
    expect(attachmentViewKind("/box/Assets/fig.PNG")).toBe("image");
    expect(attachmentViewKind("/box/Assets/diagram.svg")).toBe("image");
    expect(attachmentViewKind("/box/Assets/paper.pdf")).toBe("pdf");
    expect(attachmentViewKind("/box/Assets/clip.mp4")).toBe("video");
    expect(attachmentViewKind("/box/Assets/clip.ogv")).toBe("video");
    expect(attachmentViewKind("/box/Assets/talk.ogg")).toBe("audio");
    expect(attachmentViewKind("/box/Assets/talk.mp3")).toBe("audio");
  });

  it("has no view for notes, data files or extensionless names", () => {
    expect(attachmentViewKind("/box/note.typ")).toBeNull();
    expect(attachmentViewKind("/box/refs.bib")).toBeNull();
    expect(attachmentViewKind("/box/data.csv")).toBeNull();
    expect(attachmentViewKind("/box/README")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { folderPaths, isNoteFile, type FileEntry } from "./filelist";

/** A file list entry; only `folder` matters here. */
function entry(folder: string): FileEntry {
  return { path: `/nb/${folder}/n.typ`, name: "n.typ", folder, modified_time: 0 };
}

describe("folderPaths", () => {
  it("lists every level, not just the ones notes sit directly in", () => {
    expect(folderPaths([entry("2 Box/Drafts")])).toEqual(["2 Box", "2 Box/Drafts"]);
  });

  it("returns each folder once and skips notes at the root", () => {
    expect(
      folderPaths([entry("Archive"), entry("Archive"), entry("")]),
    ).toEqual(["Archive"]);
  });

  it("orders names naturally, so 2 comes before 10", () => {
    expect(folderPaths([entry("10 Box"), entry("2 Box")])).toEqual([
      "2 Box",
      "10 Box",
    ]);
  });
});

describe("isNoteFile", () => {
  const entry = (name: string): FileEntry => ({ path: `/box/${name}`, name, folder: "", modified_time: 0 });

  it("accepts Typst notes, whatever the extension's case", () => {
    expect(isNoteFile(entry("Draft.typ"))).toBe(true);
    expect(isNoteFile(entry("Draft.TYP"))).toBe(true);
  });

  it("rejects attachments", () => {
    for (const name of ["paper.pdf", "figure.png", "talk.mp4", "notes.typ.bak"]) {
      expect(isNoteFile(entry(name))).toBe(false);
    }
  });
});

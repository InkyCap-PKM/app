import { describe, it, expect } from "vitest";
import { folderPaths, type FileEntry } from "./filelist";

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

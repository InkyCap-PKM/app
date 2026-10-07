import { describe, expect, it } from "vitest";
import {
  getCachedSavedText,
  markCachedEditorStateSaved,
  setCachedEditorState,
} from "./tabs";

describe("cached editor state saved text", () => {
  it("is recorded for the state that was saved", () => {
    const json = { doc: "a" };
    setCachedEditorState("tab-1", "/nb/a.typ", json);
    expect(getCachedSavedText("tab-1", "/nb/a.typ")).toBeUndefined();
    markCachedEditorStateSaved("tab-1", "/nb/a.typ", json, "a");
    expect(getCachedSavedText("tab-1", "/nb/a.typ")).toBe("a");
  });

  it("is ignored once a newer state has been cached", () => {
    const first = { doc: "a" };
    const second = { doc: "b" };
    setCachedEditorState("tab-2", "/nb/a.typ", first);
    setCachedEditorState("tab-2", "/nb/a.typ", second);
    markCachedEditorStateSaved("tab-2", "/nb/a.typ", first, "a");
    expect(getCachedSavedText("tab-2", "/nb/a.typ")).toBeUndefined();
  });

  it("is cleared when the tab caches a new state", () => {
    const json = { doc: "a" };
    setCachedEditorState("tab-3", "/nb/a.typ", json);
    markCachedEditorStateSaved("tab-3", "/nb/a.typ", json, "a");
    setCachedEditorState("tab-3", "/nb/a.typ", { doc: "c" });
    expect(getCachedSavedText("tab-3", "/nb/a.typ")).toBeUndefined();
  });
});

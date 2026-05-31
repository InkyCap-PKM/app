// Unit tests for the IPC error resolver. These pin the contract with the Rust
// backend (`src-tauri/src/errors.rs`): a `{ code, message, detail }` envelope
// resolves through `errors.<code>` in the active locale, with the backend's
// English `message` as the fallback.

import { describe, it, expect, afterEach } from "vitest";
import { errorText, errorCode, type IpcError } from "./errors";
import { setLocale, DEFAULT_LOCALE } from "./i18n";

afterEach(() => setLocale(DEFAULT_LOCALE));

const envelope = (code: string, message: string, detail: string | null = null): IpcError => ({
  code,
  message,
  detail,
});

describe("errorText", () => {
  it("resolves errors.<code> and fills {detail}", () => {
    const e = envelope("file-not-found", "File not found: /x.typ", "/x.typ");
    expect(errorText(e)).toBe("File not found: /x.typ");
  });

  it("renders static-message variants with no detail", () => {
    expect(errorText(envelope("notebox-not-open", "Notebox not open"))).toBe("Notebox not open");
  });

  it("falls back to the backend message when no errors.<code> key exists", () => {
    const e = envelope("brand-new-variant", "Some new English message", "x");
    expect(errorText(e)).toBe("Some new English message");
  });

  it("translates into the active locale (pseudo-locale proves the swap is live)", () => {
    setLocale("en-XX");
    const out = errorText(envelope("notebox-not-open", "Notebox not open"));
    // Pseudo-locale brackets + accents every translated string; the detail-less
    // template still resolves, proving it routed through errors.* not the raw msg.
    expect(out).toMatch(/^⟦.*⟧$/);
  });

  it("preserves the interpolated detail verbatim through the pseudo-locale", () => {
    setLocale("en-XX");
    // `{detail}` is left intact by pseudoize, so the path survives untransformed.
    expect(errorText(envelope("git", "Git error: boom", "boom"))).toContain("boom");
  });

  it("stringifies plain JS errors via .message", () => {
    expect(errorText(new Error("kaboom"))).toBe("kaboom");
  });

  it("passes through plain strings and tolerates nullish", () => {
    expect(errorText("just a string")).toBe("just a string");
    expect(errorText(null)).toBe("");
    expect(errorText(undefined)).toBe("");
  });
});

describe("errorCode", () => {
  it("returns the machine code for an IPC envelope", () => {
    expect(errorCode(envelope("cancelled", "Cancelled"))).toBe("cancelled");
  });

  it("returns undefined for non-IPC values (so control flow can't false-match)", () => {
    expect(errorCode(new Error("nope"))).toBeUndefined();
    expect(errorCode("cancelled")).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});

// Unit tests for the i18n seam. These double as executable documentation of
// the load-bearing invariants: the static `t` contract, live locale swapping,
// and the registry-gating rule.
//
// The module loads dictionaries at import time via `import.meta.glob`, so the
// `en` source dictionary and the shipped `fr-CA` translation are both present.

import { describe, it, expect, afterEach } from "vitest";
import {
  t,
  tPlural,
  setLocale,
  localeCode,
  localeVersion,
  formatNumber,
  AVAILABLE_LOCALES,
  DEFAULT_LOCALE,
  isLocaleAvailable,
} from "./i18n";

// `i18n` is a singleton module; `setLocale` mutates shared state. Reset between
// tests so ordering can't leak.
afterEach(() => setLocale(DEFAULT_LOCALE));

describe("static t()", () => {
  it("returns the key itself on a miss (so absent strings are visible)", () => {
    expect(t("totally.missing.key")).toBe("totally.missing.key");
  });

  it("returns the translated string for a known key", () => {
    expect(t("settings.language.ui.label")).toBe("Interface language");
  });

  it("substitutes single-brace placeholders", () => {
    expect(t("wikilink.suggest.create", { name: "Foo" })).toBe("Create: Foo");
  });

  it("leaves an unprovided placeholder intact (parity with the original stub)", () => {
    expect(t("wikilink.suggest.create")).toBe("Create: {name}");
  });
});

describe("setLocale", () => {
  it("falls back to the default locale for an unknown code", () => {
    setLocale("zz-ZZ");
    expect(localeCode()).toBe(DEFAULT_LOCALE);
  });

  it("sets <html lang> and dir from the locale's metadata", () => {
    setLocale("en");
    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");
  });

  it("bumps localeVersion so static consumers can refresh", () => {
    const before = localeVersion();
    setLocale("fr-CA");
    expect(localeVersion()).toBeGreaterThan(before);
  });

  it("swaps the static dictionary live (fr-CA returns French strings)", () => {
    setLocale("fr-CA");
    expect(t("settings.language.ui.label")).toBe("Langue de l'interface");
    // The placeholder survives the swap, so substitution still works.
    expect(t("wikilink.suggest.create", { name: "Foo" })).toContain("Foo");
    setLocale("en");
    expect(t("settings.language.ui.label")).toBe("Interface language");
  });
});

describe("AVAILABLE_LOCALES registry gating", () => {
  it("offers English", () => {
    expect(AVAILABLE_LOCALES.some((l) => l.code === "en")).toBe(true);
  });

  it("only offers locales with both a loaded dictionary and complete metadata", () => {
    for (const l of AVAILABLE_LOCALES) {
      expect(isLocaleAvailable(l.code)).toBe(true);
      expect(l.nativeName.length).toBeGreaterThan(0);
      expect(["ltr", "rtl"]).toContain(l.dir);
    }
  });
});

describe("tPlural", () => {
  it("selects the English .one / .other category by count", () => {
    setLocale("en");
    expect(tPlural("references.entry", 1)).toBe("entry");
    expect(tPlural("references.entry", 0)).toBe("entries");
    expect(tPlural("references.entry", 2)).toBe("entries");
  });

  it("substitutes {count} into the chosen plural form", () => {
    setLocale("en");
    expect(tPlural("common.note", 1)).toBe("1 note");
    expect(tPlural("common.note", 5)).toBe("5 notes");
  });

  it("returns the key when no plural sub-keys exist", () => {
    expect(tPlural("no.such.plural", 2)).toBe("no.such.plural");
  });

  it("does not throw for any count", () => {
    expect(() => {
      tPlural("x", 0);
      tPlural("x", 1);
      tPlural("x", 5);
      tPlural("x", 100);
    }).not.toThrow();
  });
});

describe("formatNumber", () => {
  it("groups digits per the active locale", () => {
    setLocale("en");
    expect(formatNumber(1234567.5)).toBe("1,234,567.5");
  });
});

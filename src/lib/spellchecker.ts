// Frontend spell checker built on hunspell-asm — real Hunspell compiled to
// WebAssembly. We started on nspell (pure JS) but it can't expand affixes for
// dictionaries that use AF flag aliases + `FLAG long` (which the French
// Dicollecte dictionary, and many others, rely on): nspell recognized only base
// forms, flagging "chien", "amis", "mangé", etc. Real Hunspell handles AF
// aliases, FLAG long, complex affixes, and morphological fields natively, so all
// inflected forms check correctly.
//
// Dictionaries are loaded from the backend (bundled or user-installed .aff/.dic
// text) and cached, so toggling languages or reopening a notebox is cheap after
// first use. A `SpellChecker` accepts a word if ANY active dictionary knows it
// (bilingual notes), or if it's in the per-notebox user dictionary (the personal
// allow-list shared with the Mycelial "rescue"). User words are kept in a
// separate set rather than added to the shared Hunspell instances, so switching
// noteboxes can't leak one notebox's custom words into another's.

import { loadModule, type Hunspell, type HunspellFactory } from "hunspell-asm";
import * as ipc from "./ipc";

export interface SpellChecker {
  /** True when the word is spelled correctly per any active dictionary or the
   *  user dictionary. */
  correct(word: string): boolean;
  /** Up to a handful of suggested corrections, merged across dictionaries. */
  suggest(word: string): string[];
}

// The Hunspell WASM module is loaded once for the session.
let factoryPromise: Promise<HunspellFactory> | null = null;
function getFactory(): Promise<HunspellFactory> {
  if (!factoryPromise) factoryPromise = loadModule();
  return factoryPromise;
}

// code → Hunspell instance. Each holds its parsed dictionary in WASM memory; we
// keep instances for the life of the session (never disposed) since the set of
// languages is small and reloading parses ~1 MB of dictionary text.
const baseCache = new Map<string, Hunspell>();
const encoder = new TextEncoder();

async function loadBase(code: string): Promise<Hunspell> {
  const cached = baseCache.get(code);
  if (cached) return cached;
  const factory = await getFactory();
  const { aff, dic } = await ipc.readSpellcheckDictionary(code);
  const affPath = factory.mountBuffer(encoder.encode(aff), `${code}.aff`);
  const dicPath = factory.mountBuffer(encoder.encode(dic), `${code}.dic`);
  const instance = factory.create(affPath, dicPath);
  baseCache.set(code, instance);
  return instance;
}

/**
 * Build a checker over the given dictionary codes plus the notebox user words.
 * Returns null when no dictionary could be loaded (so callers treat "no checker"
 * as "don't underline anything"). Dictionaries that fail to load are skipped
 * with a console warning rather than failing the whole checker.
 */
export async function buildChecker(
  codes: string[],
  userWords: string[],
): Promise<SpellChecker | null> {
  const loaded = await Promise.all(
    codes.map((code) =>
      loadBase(code).catch((err) => {
        console.error(`Spellcheck: failed to load dictionary "${code}"`, err);
        return null;
      }),
    ),
  );
  const instances = loaded.filter((i): i is Hunspell => i !== null);
  if (instances.length === 0) return null;

  const userSet = new Set(userWords.map((w) => w.toLowerCase()));

  return {
    correct(word: string): boolean {
      if (!word) return true;
      if (userSet.has(word.toLowerCase())) return true;
      return instances.some((inst) => inst.spell(word));
    },
    suggest(word: string): string[] {
      const out: string[] = [];
      for (const inst of instances) {
        for (const s of inst.suggest(word)) {
          if (!out.includes(s)) out.push(s);
        }
      }
      return out.slice(0, 8);
    },
  };
}

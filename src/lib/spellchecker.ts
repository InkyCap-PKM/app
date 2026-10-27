// Spell checker using hunspell-asm (Hunspell compiled to WebAssembly), which
// handles AF flag aliases, `FLAG long` and complex affixes, as the French
// Dicollecte dictionary and many others need.
//
// Dictionaries come from the backend (bundled or user-installed .aff/.dic text)
// and are cached, so switching languages or reopening a notebox is quick after
// the first load. A `SpellChecker` accepts a word if any active dictionary knows
// it (for bilingual notes) or it's in the notebox's user dictionary (shared with
// the Mycelial rescue). User words are a separate set, not added to the shared
// Hunspell instances, so one notebox's words never appear in another.

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

// code → Hunspell instance, each holding its parsed dictionary in WASM memory.
// Kept for the session: there are few languages, and reloading parses about 1
// MB of text.
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
 * Build a checker from the dictionary codes and the notebox's user words. Null
 * if no dictionary loaded (callers then underline nothing). A dictionary that
 * fails to load is skipped with a warning.
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

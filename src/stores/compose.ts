// Compose sessions: a new note being written beside passages from other
// notes. The passages come either from the notes linked with another note
// (both the notes that link to it and the notes it links to), or from the
// notes a recurring phrase appears in (a Mycelial View emergent concept).
//
// A session belongs to the draft's tab and lives only in memory. It ends when
// that tab closes; whatever the writer kept is in the draft itself, and the
// notes it copied from are listed in the draft's `derived-from` property.
// The UI is in components/ComposePanel.tsx.

import { createRoot, createEffect, createSignal } from "solid-js";
import * as ipc from "../lib/ipc";
import type { LinkPassage } from "../lib/ipc";
import { compareChronological } from "../lib/sort";
import { reorderIndex, type DropPosition } from "../lib/drag-reorder";
import { pathEquals } from "../lib/paths";
import { tabs } from "./tabs";

/** A note a session's passages come from. */
export interface ComposeNote {
  path: string;
  name: string;
}

/** Where a session's cards come from. */
export type ComposeOrigin =
  /** The notes linked with the note at `path`, both ways. */
  | ({ kind: "links" } & ComposeNote)
  /** The notes `phrase` recurs in, in the order given. */
  | { kind: "phrase"; phrase: string; notes: ComposeNote[] };

/** One passage from a note the session draws on. */
export interface ComposeCard {
  /** Unique within a session. */
  id: string;
  /** The note the passage comes from. */
  source: ComposeNote;
  passage: LinkPassage;
  /** True when the passage is the note's opening rather than a passage that
   *  links to the origin: the origin links to the note but the note doesn't
   *  link back in its text. */
  lead: boolean;
}

export interface ComposeSession {
  origin: ComposeOrigin;
  /** Every card, in display order. */
  cards: ComposeCard[];
  dismissed: string[];
  loading: boolean;
}

const [sessions, setSessions] = createSignal<Record<string, ComposeSession>>({});

/** The session whose draft is tab `tabId`, if any. Reactive. */
export function composeSessionFor(tabId: string | null | undefined): ComposeSession | undefined {
  return tabId ? sessions()[tabId] : undefined;
}

/** The cards a session shows: all but the dismissed ones. */
export function visibleCards(session: ComposeSession): ComposeCard[] {
  return session.cards.filter((c) => !session.dismissed.includes(c.id));
}

function update(tabId: string, fn: (s: ComposeSession) => ComposeSession) {
  setSessions((prev) => (prev[tabId] ? { ...prev, [tabId]: fn(prev[tabId]) } : prev));
}

/** Start a session for the draft in tab `draftTabId` and load its cards. */
export async function beginComposeSession(
  draftTabId: string,
  origin: ComposeOrigin,
): Promise<void> {
  setSessions((prev) => ({
    ...prev,
    [draftTabId]: { origin, cards: [], dismissed: [], loading: true },
  }));
  const cards =
    origin.kind === "links"
      ? await loadLinkCards(origin.path)
      : await loadPhraseCards(origin.phrase, origin.notes);
  update(draftTabId, (s) => ({ ...s, cards, loading: false }));
}

export function dismissCard(tabId: string, cardId: string): void {
  update(tabId, (s) => ({ ...s, dismissed: [...s.dismissed, cardId] }));
}

/** Move a card to before or after another, as dropped by a drag. */
export function moveCard(
  tabId: string,
  fromId: string,
  targetId: string,
  position: DropPosition,
): void {
  update(tabId, (s) => {
    const from = s.cards.findIndex((c) => c.id === fromId);
    const target = s.cards.findIndex((c) => c.id === targetId);
    if (from < 0 || target < 0) return s;
    const to = reorderIndex(from, target, position);
    if (to === null) return s;
    const cards = [...s.cards];
    const [card] = cards.splice(from, 1);
    cards.splice(to, 0, card);
    return { ...s, cards };
  });
}

/** The cards for every note linked with the origin, oldest note first.
 *  A note gives one card per passage that links to the origin, in document
 *  order. A note with no such passage (the origin links to it, or it links
 *  only from its properties) gives one card holding its opening passage. */
async function loadLinkCards(originPath: string): Promise<ComposeCard[]> {
  try {
    const [inbound, outbound] = await Promise.all([
      ipc.getBacklinks(originPath),
      ipc.getForwardLinks(originPath),
    ]);
    const notes = [...inbound, ...outbound].filter(
      (n, i, all) =>
        !pathEquals(n.path, originPath) && all.findIndex((m) => pathEquals(m.path, n.path)) === i,
    );
    notes.sort(compareChronological);
    const perNote = await Promise.all(
      notes.map(async (source): Promise<ComposeCard[]> => {
        try {
          const passages = await ipc.getLinkPassages(source.path, originPath);
          if (passages.length > 0) {
            return passages.map((passage, i) => ({
              id: `${source.path}::${i}`,
              source,
              passage,
              lead: false,
            }));
          }
          const lead = await ipc.getLeadPassage(source.path);
          return lead ? [{ id: `${source.path}::lead`, source, passage: lead, lead: true }] : [];
        } catch {
          return [];
        }
      }),
    );
    return perNote.flat();
  } catch {
    return [];
  }
}

/** The cards for each of `notes`, in the order given: one card per passage
 *  in which `phrase` appears, in document order. */
async function loadPhraseCards(phrase: string, notes: ComposeNote[]): Promise<ComposeCard[]> {
  const perNote = await Promise.all(
    notes.map(async (source): Promise<ComposeCard[]> => {
      try {
        const passages = await ipc.getPhrasePassages(source.path, phrase);
        return passages.map((passage, i) => ({
          id: `${source.path}::${i}`,
          source,
          passage,
          lead: false,
        }));
      } catch {
        return [];
      }
    }),
  );
  return perNote.flat();
}

// A session ends when its draft's tab closes.
createRoot(() => {
  createEffect(() => {
    const open = new Set(tabs.map((t) => t.id));
    const current = sessions();
    const stale = Object.keys(current).filter((id) => !open.has(id));
    if (stale.length === 0) return;
    const next = { ...current };
    for (const id of stale) delete next[id];
    setSessions(next);
  });
});

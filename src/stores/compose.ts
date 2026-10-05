// Compose sessions: a new note being written beside the passages around
// another note's links.
//
// A session belongs to the draft's tab and lives only in memory. It ends when
// that tab closes; whatever the writer kept is in the draft itself, and the
// notes it copied from are listed in the draft's `derived-from` property.
// The UI is in components/ComposePanel.tsx.

import { createRoot, createEffect, createSignal } from "solid-js";
import * as ipc from "../lib/ipc";
import type { LinkPassage } from "../lib/ipc";
import type { LinkInfo } from "../lib/types";
import { compareChronological } from "../lib/sort";
import { reorderIndex, type DropPosition } from "../lib/drag-reorder";
import { pathEquals } from "../lib/paths";
import { tabs } from "./tabs";

/** One passage from a note that links to the origin note. */
export interface ComposeCard {
  /** Unique within a session. */
  id: string;
  /** The note the passage comes from. */
  source: LinkInfo;
  passage: LinkPassage;
}

export interface ComposeSession {
  /** The note whose inbound links supplied the cards. */
  origin: { path: string; name: string };
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
  origin: { path: string; name: string },
): Promise<void> {
  setSessions((prev) => ({
    ...prev,
    [draftTabId]: { origin, cards: [], dismissed: [], loading: true },
  }));
  const cards = await loadCards(origin.path);
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

/** One card per passage, oldest linking note first, passages within a note
 *  in document order. A note that links only from its properties gives no
 *  card. */
async function loadCards(originPath: string): Promise<ComposeCard[]> {
  try {
    const notes = (await ipc.getBacklinks(originPath)).filter(
      (n, i, all) =>
        !pathEquals(n.path, originPath) && all.findIndex((m) => pathEquals(m.path, n.path)) === i,
    );
    notes.sort(compareChronological);
    const perNote = await Promise.all(
      notes.map(async (source) => {
        try {
          const passages = await ipc.getLinkPassages(source.path, originPath);
          return passages.map((passage, i) => ({ id: `${source.path}::${i}`, source, passage }));
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

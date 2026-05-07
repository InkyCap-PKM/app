import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import * as ipc from "../lib/ipc";
import { settings } from "./settings";
import type { JournalScrollEntry } from "../lib/types";

export type JournalScrollMode = "date" | "tree" | "tag";

export interface JournalScrollState {
  enabled: boolean;
  mode: JournalScrollMode;
  anchorPath: string;
  entries: JournalScrollEntry[];
  loading: boolean;
  hasMoreAfter: boolean;
  hasMoreBefore: boolean;
}

const BATCH_SIZE = 10;

const [scrollStates, setScrollStates] = createStore<
  Record<string, JournalScrollState>
>({});

const [scrollVersion, setScrollVersion] = createSignal(0);
function bump() {
  setScrollVersion((v) => v + 1);
}

function getState(tabId: string): JournalScrollState | undefined {
  scrollVersion();
  return scrollStates[tabId];
}

function isEnabled(tabId: string): boolean {
  scrollVersion();
  return scrollStates[tabId]?.enabled ?? false;
}

function getMode(tabId: string): JournalScrollMode {
  scrollVersion();
  return scrollStates[tabId]?.mode ?? "date";
}

function getEntries(tabId: string): JournalScrollEntry[] {
  scrollVersion();
  return scrollStates[tabId]?.entries ?? [];
}

function isLoading(tabId: string): boolean {
  scrollVersion();
  return scrollStates[tabId]?.loading ?? false;
}

async function toggleScroll(tabId: string, anchorPath: string) {
  const current = scrollStates[tabId];
  if (current?.enabled) {
    setScrollStates(
      produce((s) => {
        if (s[tabId]) s[tabId].enabled = false;
      }),
    );
    bump();
    return;
  }

  setScrollStates(
    produce((s) => {
      s[tabId] = {
        enabled: true,
        mode: "date",
        anchorPath,
        entries: [],
        loading: true,
        hasMoreAfter: true,
        hasMoreBefore: true,
      };
    }),
  );
  bump();

  await loadInitial(tabId, anchorPath, "date");
}

async function setMode(tabId: string, mode: JournalScrollMode) {
  const state = scrollStates[tabId];
  if (!state) return;

  setScrollStates(
    produce((s) => {
      s[tabId].mode = mode;
      s[tabId].entries = [];
      s[tabId].loading = true;
      s[tabId].hasMoreAfter = true;
      s[tabId].hasMoreBefore = true;
    }),
  );
  bump();

  await loadInitial(tabId, state.anchorPath, mode);
}

async function loadInitial(
  tabId: string,
  anchorPath: string,
  mode: JournalScrollMode,
) {
  const config = {
    date_sort: settings.journal_scroll.date_sort,
    tree_scope: settings.journal_scroll.tree_scope,
  };

  try {
    const files = await ipc.getJournalScrollFiles(
      anchorPath,
      mode,
      config,
      0,
      BATCH_SIZE,
    );

    setScrollStates(
      produce((s) => {
        if (!s[tabId]) return;
        s[tabId].entries = files;
        s[tabId].loading = false;
        s[tabId].hasMoreAfter = files.length >= BATCH_SIZE;
      }),
    );
    bump();
  } catch (err) {
    console.error("Journal scroll load failed:", err);
    setScrollStates(
      produce((s) => {
        if (s[tabId]) s[tabId].loading = false;
      }),
    );
    bump();
  }
}

async function loadMore(tabId: string) {
  const state = scrollStates[tabId];
  if (!state || state.loading || !state.hasMoreAfter) return;

  setScrollStates(
    produce((s) => {
      s[tabId].loading = true;
    }),
  );
  bump();

  const config = {
    date_sort: settings.journal_scroll.date_sort,
    tree_scope: settings.journal_scroll.tree_scope,
  };

  try {
    const files = await ipc.getJournalScrollFiles(
      state.anchorPath,
      state.mode,
      config,
      state.entries.length,
      BATCH_SIZE,
    );

    setScrollStates(
      produce((s) => {
        if (!s[tabId]) return;
        s[tabId].entries = [...s[tabId].entries, ...files];
        s[tabId].loading = false;
        s[tabId].hasMoreAfter = files.length >= BATCH_SIZE;
      }),
    );
    bump();
  } catch (err) {
    console.error("Journal scroll load more failed:", err);
    setScrollStates(
      produce((s) => {
        if (s[tabId]) s[tabId].loading = false;
      }),
    );
    bump();
  }
}

function updateAnchor(tabId: string, newAnchorPath: string) {
  const state = scrollStates[tabId];
  if (!state || !state.enabled) return;
  if (state.anchorPath === newAnchorPath) return;

  setScrollStates(
    produce((s) => {
      s[tabId].anchorPath = newAnchorPath;
      s[tabId].entries = [];
      s[tabId].loading = true;
      s[tabId].hasMoreAfter = true;
      s[tabId].hasMoreBefore = true;
    }),
  );
  bump();

  loadInitial(tabId, newAnchorPath, state.mode);
}

function cleanup(tabId: string) {
  setScrollStates(
    produce((s) => {
      delete s[tabId];
    }),
  );
}

export {
  getState,
  isEnabled,
  getMode,
  getEntries,
  isLoading,
  toggleScroll,
  setMode,
  loadMore,
  updateAnchor,
  cleanup,
};

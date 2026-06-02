// Right-panel Annotations pane: lists every `#annotation` comment and
// `#suggestion` tracked change in the active note. Clicking a row jumps to the
// change in the editor (scroll + caret) so the reviewer sees where it is;
// resolving a tracked change (Accept/Reject/Comment) is a separate per-row
// action via the row's menu button, so the menu never obscures the list on a
// navigation click. Filters by text at the top, and a fixed bottom toolbar
// inserts new markup at the editor cursor.

import { Component, For, Show, createSignal, createMemo, createEffect } from "solid-js";
import { EditorView } from "@codemirror/view";
import { attachListNav } from "../lib/list-nav";
import { X, Plus, Minus, Replace, MessageSquare, UserPen, RotateCcw } from "lucide-solid";
import {
  noteAnnotations,
  rescanAnnotations,
  type AnnotationEntry,
  type AnnotationKind,
} from "../editor/typst-decorations/annotation-tracker";
import {
  insertAnnotationMarkup,
  type InsertKind,
} from "../editor/typst-decorations/annotation-insert";
import { openSuggestionMenu } from "../editor/typst-decorations/widgets";
import { applyCallTransform } from "../editor/typst-decorations/pill";
import { activeEditorView } from "../stores/editor";
import { getActiveTab } from "../stores/tabs";
import {
  collaborative,
  syncReviewVersion,
  changesSinceSync,
  revertSyncHunk,
  revertNoteSinceSync,
} from "../stores/git";
import { promptConfirm } from "../stores/prompt";
import { pathEquals } from "../lib/paths";
import * as ipc from "../lib/ipc";
import type { GitSyncHunk, GitSyncNoteDiff } from "../lib/types";
import NoteHistory from "./NoteHistory";
import { useI18n } from "../lib/i18n";

/** Semantic tone for a kind's icon + badge (mirrors the inline colours). */
function tone(kind: AnnotationKind): string {
  switch (kind) {
    case "insert":
      return "insert";
    case "delete":
      return "delete";
    case "replace":
      return "replace";
    default:
      return "comment";
  }
}

const KindIcon: Component<{ kind: AnnotationKind }> = (props) => {
  switch (props.kind) {
    case "insert":
      return <Plus size={14} />;
    case "delete":
      return <Minus size={14} />;
    case "replace":
      return <Replace size={14} />;
    default:
      return <MessageSquare size={14} />;
  }
};

/** What kind of change a hunk represents, from which of its two sides is empty. */
function hunkKind(h: GitSyncHunk): "added" | "removed" | "changed" {
  if (!h.baselineText) return "added";
  if (!h.currentText) return "removed";
  return "changed";
}

/** A compact one-line preview of a side of a hunk (first non-empty line). */
function preview(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return (line ?? "").trim();
}

/** The merge-first "Incoming since last sync" review section, shown at the top of
 *  the Changes view for a collaborative note. Lists the changes the last Sync /
 *  import folded into THIS note (relative to the recorded pre-sync baseline) and
 *  lets the reviewer revert any hunk — or the whole note — back to their version.
 *  Empty (renders nothing) when the note matches its baseline. Separate from the
 *  manual `#annotation`/`#suggestion` author tools listed below it. */
const IncomingChanges: Component<{ path: string | null }> = (props) => {
  const t = useI18n();
  const [diff, setDiff] = createSignal<GitSyncNoteDiff | null>(null);

  // Refetch the per-note diff when the note changes, when this pane mounts, and
  // whenever the working tree moved (an edit or a revert bumps the store's
  // sync-review version) so the two change lists stay current.
  createEffect(() => {
    syncReviewVersion(); // dependency: refetch after edits / reverts / syncs
    const path = props.path;
    if (!path || !collaborative()) {
      setDiff(null);
      return;
    }
    void ipc
      .gitNoteSyncDiff(path)
      .then((d) => setDiff(d))
      .catch((err) => {
        console.error("git note sync-diff failed:", err);
        setDiff(null);
      });
  });

  const incoming = () => diff()?.incoming ?? [];
  const local = () => diff()?.local ?? [];
  const incomingCreated = () => diff()?.incomingCreated ?? false;
  const localCreated = () => diff()?.localCreated ?? false;
  const hasIncoming = () => incoming().length > 0 || incomingCreated();
  const hasLocal = () => local().length > 0 || localCreated();
  const noteName = () => {
    const p = props.path;
    return p ? p.split("/").pop() ?? p : "";
  };

  /** Revert the whole note to its pre-sync baseline, with a confirm — this
   *  discards every incoming change at once (unlike the per-hunk reverts, which
   *  are individually visible). When the sync *added* the note, reverting deletes
   *  it, so the confirm says so. Recoverable from git history either way. */
  async function revertWholeNote() {
    const path = props.path;
    if (!path) return;
    const name = path.split("/").pop() ?? path;
    const wasAdded =
      incomingCreated() ||
      changesSinceSync().some((e) => pathEquals(e.path, path) && e.status === "added");
    const ok = await promptConfirm({
      title: t("git.sinceSync.revertConfirmTitle"),
      message: wasAdded
        ? t("git.sinceSync.revertConfirmBodyAdded", { name })
        : t("git.sinceSync.revertConfirmBody", { name }),
      confirmLabel: t("git.sinceSync.revert"),
    });
    if (ok) void revertNoteSinceSync(path);
  }

  /** Scroll the editor to where a hunk sits (its current-side start line). */
  function reveal(h: GitSyncHunk) {
    const handle = activeEditorView();
    if (!handle) return;
    const view = handle.view;
    const lineNo = Math.min(Math.max(h.currentStart + 1, 1), view.state.doc.lines);
    const pos = view.state.doc.line(lineNo).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }

  /** One change row. `revertable` adds the per-hunk revert button (incoming
   *  changes only — local edits are your own work, managed by editing). */
  function hunkRow(h: GitSyncHunk, revertable: boolean) {
    const kind = hunkKind(h);
    const tone = kind === "added" ? "insert" : kind === "removed" ? "delete" : "replace";
    return (
      <div
        class="sidebar-item annotations-panel__item"
        onClick={() => reveal(h)}
        title={t("annotations.incoming.reveal")}
      >
        <span class={`sidebar-item__icon annotations-panel__icon--${tone}`}>
          {kind === "added" ? <Plus size={14} /> : kind === "removed" ? <Minus size={14} /> : <Replace size={14} />}
        </span>
        <span class="annotations-panel__body">
          <span class="annotations-panel__primary">
            <span class="sidebar-item__label">
              {kind === "added"
                ? preview(h.currentText)
                : kind === "removed"
                  ? preview(h.baselineText)
                  : `${preview(h.baselineText)} → ${preview(h.currentText)}`}
            </span>
            <span class={`annotations-panel__badge annotations-panel__badge--${tone}`}>
              {t(`annotations.incoming.kind.${kind}`)}
            </span>
          </span>
        </span>
        <Show when={revertable}>
          <button
            class="annotations-panel__revert"
            title={t("annotations.incoming.revert")}
            aria-label={t("annotations.incoming.revert")}
            onClick={(e) => {
              e.stopPropagation();
              props.path && void revertSyncHunk(props.path, h.currentStart, h.currentEnd);
            }}
          >
            <RotateCcw size={13} />
          </button>
        </Show>
      </div>
    );
  }

  /** A "whole note was created/added" status row, shown instead of a noisy
   *  whole-file "added" hunk (whose first line is the import preamble). */
  function createdRow(label: string) {
    return (
      <div class="sidebar-item annotations-panel__item" title={label}>
        <span class="sidebar-item__icon annotations-panel__icon--insert">
          <Plus size={14} />
        </span>
        <span class="annotations-panel__body">
          <span class="annotations-panel__primary">
            <span class="sidebar-item__label">{label}</span>
            <span class="annotations-panel__badge annotations-panel__badge--insert">
              {t("annotations.incoming.kind.added")}
            </span>
          </span>
        </span>
      </div>
    );
  }

  return (
    <Show when={hasIncoming() || hasLocal()}>
      <div class="annotations-panel__incoming">
        {/* Incoming: what the last sync folded in — reviewable + revertable. */}
        <Show when={hasIncoming()}>
          <div class="annotations-panel__incoming-header">
            <span class="annotations-panel__list-heading">
              {t("annotations.incoming.heading")}
            </span>
            <button
              class="annotations-panel__incoming-revert-all"
              title={t("annotations.incoming.revertNote")}
              aria-label={t("annotations.incoming.revertNote")}
              onClick={() => void revertWholeNote()}
            >
              <RotateCcw size={12} /> {t("annotations.incoming.revertAll")}
            </button>
          </div>
          <div class="annotations-panel__list">
            <Show when={incomingCreated()}>
              {createdRow(t("annotations.incoming.created", { name: noteName() }))}
            </Show>
            <For each={incoming()}>{(h) => hunkRow(h, true)}</For>
          </div>
        </Show>

        {/* Local activity: your own uncommitted edits since the sync —
            informational, so these rows have no revert button. */}
        <Show when={hasLocal()}>
          <div class="annotations-panel__incoming-header">
            <span class="annotations-panel__list-heading">
              {t("annotations.local.heading")}
            </span>
          </div>
          <div class="annotations-panel__list">
            <Show when={localCreated()}>
              {createdRow(t("annotations.local.created", { name: noteName() }))}
            </Show>
            <For each={local()}>{(h) => hunkRow(h, false)}</For>
          </div>
        </Show>
      </div>
    </Show>
  );
};

/** Which half of the Changes & History pane is showing. Persisted as a UI
 *  preference (module-level + localStorage) so it survives note/tab switches and
 *  app restarts rather than snapping back to "Changes" each time the pane
 *  remounts. */
const VIEW_STORAGE_KEY = "inkycap.annotationsPanel.view";
function loadPanelView(): "changes" | "history" {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "history" ? "history" : "changes";
  } catch {
    return "changes";
  }
}
const [panelView, setPanelViewInternal] = createSignal<"changes" | "history">(loadPanelView());
function setPanelView(v: "changes" | "history") {
  setPanelViewInternal(v);
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, v);
  } catch {
    /* no-op: localStorage may be unavailable in some webview contexts */
  }
}

const AnnotationsPanel: Component = () => {
  const t = useI18n();
  const kindLabel = (kind: AnnotationKind): string => t(`annotations.kind.${kind}`);
  const [filter, setFilter] = createSignal("");
  const view = panelView;
  const setView = setPanelView;
  // The open note's path, for the History view. Null when the active tab isn't
  // a file note (the pane only renders for a file tab, so this is defensive).
  const notePath = createMemo(() => {
    const tab = getActiveTab();
    return tab && tab.type === "file" ? tab.path : null;
  });

  // Scan the active editor when this pane opens (the component mounts) and
  // whenever the active editor changes (tab switch). Live edits while the pane
  // is open are kept current by the annotation tracker plugin.
  createEffect(() => {
    rescanAnnotations(activeEditorView()?.view);
  });

  const visible = createMemo(() => {
    const q = filter().trim().toLowerCase();
    const all = noteAnnotations();
    if (!q) return all;
    return all.filter(
      (a) =>
        a.body.toLowerCase().includes(q) ||
        a.oldText.toLowerCase().includes(q) ||
        a.note.toLowerCase().includes(q) ||
        a.by.toLowerCase().includes(q) ||
        kindLabel(a.kind).toLowerCase().includes(q),
    );
  });

  /** The primary text shown for a row. */
  const primary = (a: AnnotationEntry): string => {
    const body = a.body.trim();
    if (a.kind === "replace") {
      const old = a.oldText.trim();
      if (old && body) return `${old} → ${body}`;
      return body || old || t("annotations.emptyItem");
    }
    return body || t("annotations.emptyItem");
  };

  const attribution = (a: AnnotationEntry): string =>
    [a.by, a.on].filter(Boolean).join(" · ");

  /** Click a row: jump to the change in the document — scroll it into view and
   *  place the caret at it — so the reviewer can see *where* it is. Resolving a
   *  tracked change (Accept / Reject / Comment) is a separate, explicit action
   *  via the row's menu button ([`openMenu`]), so it doesn't obscure the list. */
  function activate(a: AnnotationEntry) {
    const handle = activeEditorView();
    if (!handle) return;
    const view = handle.view;
    const pos = Math.min(a.from, view.state.doc.length);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }

  /** Open a tracked change's Accept / Reject / Comment menu, anchored to the
   *  row's menu button. Suggestions only — a plain comment has no resolution. */
  function openMenu(a: AnnotationEntry, anchorEl: HTMLElement) {
    const view = activeEditorView()?.view;
    // The menu resolves a tracked change; a plain comment has none (and only
    // suggestions render this button). The guard also narrows `a.kind` to the
    // suggestion kinds the menu accepts.
    if (!view || a.kind === "annotation") return;
    openSuggestionMenu(
      view,
      { kind: a.kind, body: a.body, oldText: a.oldText, by: a.by, on: a.on, note: a.note, from: a.from },
      anchorEl,
    );
  }

  /** Dismiss a comment (`#annotation[…]`) that is no longer relevant — delete the
   *  call. The annotation tracker updates the list reactively on the change. */
  function dismiss(a: AnnotationEntry) {
    const view = activeEditorView()?.view;
    if (!view) return;
    applyCallTransform(view, a.from, () => "");
    view.focus();
  }

  /** Insert markup at the editor cursor. `onMouseDown` + preventDefault keeps
   *  the editor focused so the insert lands at its caret, not the toolbar. */
  function insert(e: MouseEvent, kind: InsertKind) {
    e.preventDefault();
    insertAnnotationMarkup(activeEditorView()?.view, kind);
  }

  return (
    <div class="annotations-panel">
      <div class="right-panel__section-header annotations-panel__header">
        <span>{t("annotations.paneTitle")}</span>
        <div class="annotations-panel__view-toggle" role="tablist">
          <button
            class={`annotations-panel__view-btn${view() === "changes" ? " annotations-panel__view-btn--active" : ""}`}
            role="tab"
            aria-selected={view() === "changes"}
            onClick={() => setView("changes")}
          >
            {t("annotations.view.changes")}
          </button>
          <button
            class={`annotations-panel__view-btn${view() === "history" ? " annotations-panel__view-btn--active" : ""}`}
            role="tab"
            aria-selected={view() === "history"}
            onClick={() => setView("history")}
          >
            {t("annotations.view.history")}
          </button>
        </div>
      </div>

      <Show
        when={view() === "changes"}
        fallback={
          <Show when={notePath()}>{(p) => <NoteHistory path={p()} />}</Show>
        }
      >
      <Show when={collaborative()}>
        <IncomingChanges path={notePath()} />
      </Show>
      <div class="right-panel__links-filter-wrap">
        <input
          class="right-panel__links-filter-input"
          type="text"
          placeholder={t("annotations.filterPlaceholder")}
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFilter("");
          }}
        />
        <Show when={filter().length > 0}>
          <button
            class="right-panel__links-filter-clear"
            onClick={() => setFilter("")}
            title={t("references.clearFilter")}
            aria-label={t("references.clearFilter")}
          >
            <X size={12} />
          </button>
        </Show>
      </div>

      <Show when={visible().length > 0}>
        <p class="annotations-panel__list-heading">{t("annotations.changesRequireDecision")}</p>
      </Show>

      <div class="annotations-panel__list" ref={attachListNav} aria-label={t("annotations.title")}>
        <Show
          when={visible().length > 0}
          fallback={<p class="sidebar-hint">{t("annotations.empty")}</p>}
        >
          <For each={visible()}>
            {(a) => (
              <div
                data-list-item
                class="sidebar-item annotations-panel__item"
                onClick={() => activate(a)}
                title={primary(a)}
              >
                <span class={`sidebar-item__icon annotations-panel__icon--${tone(a.kind)}`}>
                  <KindIcon kind={a.kind} />
                </span>
                <span class="annotations-panel__body">
                  <span class="annotations-panel__primary">
                    <span class="sidebar-item__label">{primary(a)}</span>
                    <span class={`annotations-panel__badge annotations-panel__badge--${tone(a.kind)}`}>
                      {kindLabel(a.kind)}
                    </span>
                  </span>
                  <Show when={attribution(a)}>
                    <span class="annotations-panel__secondary">{attribution(a)}</span>
                  </Show>
                  <Show when={a.note.trim()}>
                    <span class="annotations-panel__note">
                      <MessageSquare size={11} /> {a.note.trim()}
                    </span>
                  </Show>
                </span>
                {/* Row click jumps to the change; resolving / dismissing is an
                    explicit per-row action so it never fires on a navigation
                    click. A tracked change opens its Accept/Reject/Comment menu;
                    a standalone comment (no resolution) can be dismissed. */}
                <Show
                  when={a.kind === "annotation"}
                  fallback={
                    <button
                      class="annotations-panel__action"
                      title={t("annotations.openMenu")}
                      aria-label={t("annotations.openMenu")}
                      onClick={(e) => {
                        e.stopPropagation();
                        openMenu(a, e.currentTarget as HTMLElement);
                      }}
                    >
                      <UserPen size={14} />
                    </button>
                  }
                >
                  <button
                    class="annotations-panel__action annotations-panel__action--danger"
                    title={t("annotations.dismiss")}
                    aria-label={t("annotations.dismiss")}
                    onClick={(e) => {
                      e.stopPropagation();
                      dismiss(a);
                    }}
                  >
                    <X size={13} />
                  </button>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>

      <div class="annotations-panel__toolbar">
        <button
          class="annotations-panel__tool annotations-panel__tool--insert"
          onMouseDown={(e) => insert(e, "insert")}
          title={t("annotations.tool.insert")}
          aria-label={t("annotations.tool.insert")}
        >
          <Plus size={16} />
        </button>
        <button
          class="annotations-panel__tool annotations-panel__tool--delete"
          onMouseDown={(e) => insert(e, "delete")}
          title={t("annotations.tool.delete")}
          aria-label={t("annotations.tool.delete")}
        >
          <Minus size={16} />
        </button>
        <button
          class="annotations-panel__tool annotations-panel__tool--replace"
          onMouseDown={(e) => insert(e, "replace")}
          title={t("annotations.tool.replace")}
          aria-label={t("annotations.tool.replace")}
        >
          <Replace size={16} />
        </button>
        <button
          class="annotations-panel__tool annotations-panel__tool--comment"
          onMouseDown={(e) => insert(e, "annotation")}
          title={t("annotations.tool.annotation")}
          aria-label={t("annotations.tool.annotation")}
        >
          <MessageSquare size={16} />
        </button>
      </div>
      </Show>
    </div>
  );
};

export default AnnotationsPanel;

// Right panel: tabbed view with Properties, Outline, and Links
// for the active file.

import { Component, createEffect, createResource, createSignal, For, Show, onCleanup } from "solid-js";
import { getActiveTab, openTab, closeTab } from "../stores/tabs";
import type { LinkInfo, PropertyType, PropertyValue } from "../lib/types";
import * as ipc from "../lib/ipc";
import { indexReady, bumpPropertyVersion } from "../stores/vault";
import {
  PROPERTY_TYPE_OPTIONS,
  propertyTypeLabel,
  propertyTypeIcon,
  reloadPropertyTypes,
  propertyType as getPropertyType,
} from "../stores/propertyTypes";
import PropertyEditor from "./PropertyEditor";
import OutlinePanel from "./OutlinePanel";
import { EllipsisVertical, NotebookTabs, TableOfContents, Link, BrainCircuit, Quote } from "lucide-solid";
import { Dynamic } from "solid-js/web";
import ReferencesPanel from "./ReferencesPanel";
import { ask, open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { toastError, toastWarning } from "../stores/toasts";

type RightPanelTab = "properties" | "outline" | "links" | "references";

const KNOWN_FIELDS_ORDERED = [
  "title", "aliases", "description", "tags", "date", "date-due",
  "task", "status", "disposition", "source", "zid", "collection",
];
const KNOWN_FIELDS = new Set(KNOWN_FIELDS_ORDERED);

const KNOWN_FIELD_TYPES: Record<string, PropertyType> = {
  title: "text",
  aliases: "list",
  description: "text",
  tags: "list",
  date: "date",
  "date-due": "date",
  task: "checkbox",
  status: "list",
  disposition: "list",
  source: "text",
  zid: "number",
  collection: "list",
};

function defaultForType(ty: PropertyType): PropertyValue {
  switch (ty) {
    case "checkbox": return false;
    case "number": return 0;
    case "list": return [];
    case "date":
    case "datetime":
    case "text":
    default:
      return "";
  }
}

function defaultForKey(key: string): PropertyValue {
  const knownType = KNOWN_FIELD_TYPES[key];
  if (knownType) return defaultForType(knownType);
  return "";
}

/** Extended link info with context snippet and resolved state. */
interface BacklinkWithContext extends LinkInfo {
  context?: string;
}

interface ForwardLinkResolved extends LinkInfo {
  resolved: boolean;
  /** The raw wikilink target text. */
  target: string;
}

const RightPanel: Component = () => {
  const [activePanel, setActivePanel] = createSignal<RightPanelTab>("properties");
  const [addingProp, setAddingProp] = createSignal(false);
  const [newPropKey, setNewPropKey] = createSignal("");
  const [newPropType, setNewPropType] = createSignal<PropertyType>("text");
  const [allPropKeys, setAllPropKeys] = createSignal<string[]>([]);
  const [addPropHighlight, setAddPropHighlight] = createSignal(0);

  // Per-row context menu state. Anchored to a DOM element so the menu
  // opens below the clicked type button without needing global mouse
  // coordinates. `openLeft` flips the Property type submenu to the
  // left side of the parent menu when there isn't room for it on the
  // right — the ⋮ button in the right panel sits close to the window
  // edge, so a normally-rightward submenu overflows off-screen.
  const [rowMenu, setRowMenu] = createSignal<{
    key: string;
    x: number;
    y: number;
    typeSubmenuOpen: boolean;
    openLeft: boolean;
  } | null>(null);

  function closeRowMenu() {
    setRowMenu(null);
  }

  const activeFileTab = () => {
    const tab = getActiveTab();
    return tab?.type === "file" ? tab : undefined;
  };

  const [metadata, { refetch: refetchMetadata }] = createResource(
    () => activeFileTab()?.path,
    async (path) => {
      if (!path) return undefined;
      try {
        return await ipc.getFileMetadata(path);
      } catch {
        return undefined;
      }
    },
  );

  // Source-order list of property keys so the right panel renders rows in
  // whatever order the user has set inside the file's #note(...) — without
  // this we'd snap rows back to KNOWN_FIELDS_ORDERED on every drag/drop.
  const [propertyOrder, { refetch: refetchPropertyOrder }] = createResource(
    () => activeFileTab()?.path,
    async (path) => {
      if (!path) return [] as string[];
      try {
        return await ipc.getPropertyOrder(path);
      } catch {
        return [] as string[];
      }
    },
  );

  // Drag/drop state. `draggingKey` is the row being dragged; `dragOverKey`
  // identifies the hovered drop target; `dropPosition` says whether the
  // drop indicator sits above or below the target row.
  const [draggingKey, setDraggingKey] = createSignal<string | null>(null);
  const [dragOverKey, setDragOverKey] = createSignal<string | null>(null);
  const [dropPosition, setDropPosition] = createSignal<"before" | "after">("before");

  function sortedPropertyEntries(): [string, PropertyValue][] {
    const meta = metadata();
    if (!meta) return [];
    const entries = Object.entries(meta.properties).filter(
      ([k]) => !k.startsWith("file."),
    );
    const order = propertyOrder() ?? [];
    if (order.length === 0) {
      // Fallback default sort: known-fields canonical order, then alpha.
      return entries.sort(([a], [b]) => {
        const ai = KNOWN_FIELDS_ORDERED.indexOf(a);
        const bi = KNOWN_FIELDS_ORDERED.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
      });
    }
    const orderIdx = new Map(order.map((k, i) => [k, i]));
    return entries.sort(([a], [b]) => {
      const ai = orderIdx.has(a) ? orderIdx.get(a)! : Infinity;
      const bi = orderIdx.has(b) ? orderIdx.get(b)! : Infinity;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });
  }

  async function commitReorder(newOrder: string[]) {
    const tab = activeFileTab();
    if (!tab) return;
    try {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 200);
        document.dispatchEvent(
          new CustomEvent("inkycap:flush-editor", {
            detail: { path: tab.path, done: () => { clearTimeout(timeout); resolve(); } },
          }),
        );
      });
      await ipc.reorderProperties(tab.path, newOrder);
      await refetchPropertyOrder();
      await refetchMetadata();
      bumpPropertyVersion();
      document.dispatchEvent(
        new CustomEvent("inkycap:note-property-changed", { detail: { path: tab.path } }),
      );
    } catch (err) {
      toastError("Failed to reorder properties", err);
    }
  }

  function handleDragStart(e: DragEvent, key: string) {
    setDraggingKey(key);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Some browsers require non-empty data for drag to fire correctly.
      e.dataTransfer.setData("text/plain", key);
    }
  }

  function handleDragEnd() {
    setDraggingKey(null);
    setDragOverKey(null);
  }

  function handleDragOver(e: DragEvent, key: string) {
    if (!draggingKey() || draggingKey() === key) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    setDropPosition(e.clientY < midpoint ? "before" : "after");
    setDragOverKey(key);
  }

  function handleDrop(e: DragEvent, targetKey: string) {
    e.preventDefault();
    const src = draggingKey();
    setDragOverKey(null);
    setDraggingKey(null);
    if (!src || src === targetKey) return;
    const entries = sortedPropertyEntries().map(([k]) => k);
    const without = entries.filter((k) => k !== src);
    const targetIdx = without.indexOf(targetKey);
    if (targetIdx === -1) return;
    const insertAt = dropPosition() === "before" ? targetIdx : targetIdx + 1;
    const next = [...without.slice(0, insertAt), src, ...without.slice(insertAt)];
    commitReorder(next);
  }

  // Refetch metadata when the note is saved by the editor.
  // The event fires after writeFileContent completes (reindex already done).
  const onNoteSaved = () => {
    setTimeout(() => {
      refetchMetadata();
      refetchPropertyOrder();
    }, 150);
  };
  document.addEventListener("inkycap:note-saved", onNoteSaved);
  onCleanup(() => document.removeEventListener("inkycap:note-saved", onNoteSaved));

  const [backlinks, { refetch: refetchBacklinks }] = createResource(
    () => activeFileTab()?.path,
    async (path): Promise<BacklinkWithContext[]> => {
      if (!path) return [];
      try {
        const links = await ipc.getBacklinks(path);
        // Deduplicate by path — a note may link to us multiple times
        const seen = new Set<string>();
        const unique = links.filter((link) => {
          if (seen.has(link.path)) return false;
          seen.add(link.path);
          return true;
        });
        return await Promise.all(
          unique.map(async (link) => {
            try {
              const ctx = await ipc.getBacklinkContext(link.path, path);
              return { ...link, context: ctx ?? undefined };
            } catch {
              return { ...link };
            }
          }),
        );
      } catch {
        return [];
      }
    },
  );

  const [forwardLinks, { refetch: refetchForwardLinks }] = createResource(
    () => activeFileTab()?.path,
    async (path): Promise<ForwardLinkResolved[]> => {
      if (!path) return [];
      try {
        const meta = await ipc.getFileMetadata(path);
        if (!meta) return [];

        // Deduplicate targets before resolving
        const uniqueTargets = [...new Set(meta.links)];
        return await Promise.all(
          uniqueTargets.map(async (target) => {
            const resolvedPath = await ipc.resolveWikilink(target);
            if (resolvedPath) {
              const name = resolvedPath
                .split("/")
                .pop()
                ?.replace(/\.[^.]+$/, "") ?? target;
              return {
                path: resolvedPath,
                name,
                resolved: true,
                target,
              } as ForwardLinkResolved;
            }
            return {
              path: "",
              name: target,
              resolved: false,
              target,
            } as ForwardLinkResolved;
          }),
        );
      } catch {
        return [];
      }
    },
  );

  // When the background index build finishes, refetch link data so that
  // the Links tab populates without the user having to switch tabs.
  createEffect(() => {
    if (indexReady() && activeFileTab()) {
      refetchBacklinks();
      refetchForwardLinks();
    }
  });

  function openLinkedFile(link: LinkInfo) {
    if (!link.path) return;
    openTab({ type: "file", title: link.name, path: link.path });
  }

  async function createUnresolvedNote(target: string) {
    try {
      const path = await ipc.createNote(target, "", undefined);
      openTab({ type: "file", title: target, path }, { forceNewTab: true });
    } catch (e) {
      toastError("Failed to create note", e);
    }
  }

  async function handlePropertySave(key: string, value: PropertyValue) {
    const tab = activeFileTab();
    if (!tab) return;

    try {
      // Flush any pending editor save so the disk is up-to-date before
      // the backend reads and rewrites the file.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 200);
        document.dispatchEvent(
          new CustomEvent("inkycap:flush-editor", {
            detail: { path: tab.path, done: () => { clearTimeout(timeout); resolve(); } },
          }),
        );
      });

      await ipc.updateProperty(tab.path, key, value);
      await refetchMetadata();
      await refetchPropertyOrder();
      bumpPropertyVersion();
      document.dispatchEvent(
        new CustomEvent("inkycap:note-property-changed", { detail: { path: tab.path } }),
      );
    } catch (err) {
      toastError("Failed to update property", err);
    }
  }

  async function handleRemoveProperty(key: string) {
    const tab = activeFileTab();
    if (!tab) return;
    closeRowMenu();
    try {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 200);
        document.dispatchEvent(
          new CustomEvent("inkycap:flush-editor", {
            detail: { path: tab.path, done: () => { clearTimeout(timeout); resolve(); } },
          }),
        );
      });
      await ipc.removePropertyFromFile(tab.path, key);
      await refetchMetadata();
      await refetchPropertyOrder();
      bumpPropertyVersion();
      document.dispatchEvent(
        new CustomEvent("inkycap:note-property-changed", { detail: { path: tab.path } }),
      );
    } catch (err) {
      toastError("Failed to remove property", err);
    }
  }

  async function handleSetRowPropertyType(key: string, ty: PropertyType) {
    closeRowMenu();
    try {
      await ipc.setPropertyType(key, ty);
      await reloadPropertyTypes();
      refetchMetadata();
    } catch (err) {
      toastError("Failed to set property type", err);
    }
  }

  let cleanupRowMenu: (() => void) | undefined;

  function openRowMenu(e: MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    if (cleanupRowMenu) {
      cleanupRowMenu();
      cleanupRowMenu = undefined;
    }
    if (rowMenu()) {
      closeRowMenu();
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const MENU_W = 200;
    const MENU_H = 120;
    const SUBMENU_W = 180;
    let x = rect.left;
    let y = rect.bottom + 4;
    if (x + MENU_W > window.innerWidth - 8) {
      x = Math.max(8, window.innerWidth - MENU_W - 8);
    }
    if (y + MENU_H > window.innerHeight - 8) {
      y = Math.max(8, rect.top - MENU_H - 4);
    }
    const openLeft = x + MENU_W + SUBMENU_W > window.innerWidth - 8;
    setRowMenu({ key, x, y, typeSubmenuOpen: false, openLeft });
    setTimeout(() => {
      const onDocClick = () => {
        closeRowMenu();
        document.removeEventListener("click", onDocClick);
        cleanupRowMenu = undefined;
      };
      document.addEventListener("click", onDocClick);
      cleanupRowMenu = () => {
        document.removeEventListener("click", onDocClick);
      };
    }, 0);
  }

  async function handleAddProperty(forcedKey?: string) {
    const key = (forcedKey ?? newPropKey()).trim();
    if (!key) return;
    const ty = newPropType();
    const knownType = KNOWN_FIELD_TYPES[key];
    const registryType = getPropertyType(key);
    const effectiveType = knownType ?? (registryType !== "auto" ? registryType : ty);
    const defaultValue = defaultForType(effectiveType);
    if (!knownType && registryType === "auto" && ty !== "auto") {
      try {
        await ipc.setPropertyType(key, ty);
        await reloadPropertyTypes();
      } catch (err) {
        toastError("Failed to set property type", err);
      }
    }
    handlePropertySave(key, defaultValue);
    setNewPropKey("");
    setNewPropType("text");
    setAddingProp(false);
  }

  // Suggestions for the add-property input: known keys (canonical order)
  // plus any custom keys, filtered by the current draft and excluding
  // properties already present on the active note.
  function addPropSuggestions(): string[] {
    const current = metadata()?.properties ?? {};
    const draft = newPropKey().trim().toLowerCase();
    const universe = allPropKeys().filter((k) => !(k in current));
    if (!draft) return universe;
    return universe.filter((k) => k.toLowerCase().includes(draft));
  }

  function handleAddKeyDown(e: KeyboardEvent) {
    const suggestions = addPropSuggestions();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (suggestions.length === 0) return;
      setAddPropHighlight((i) => Math.min(suggestions.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (suggestions.length === 0) return;
      setAddPropHighlight((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const idx = addPropHighlight();
      if (suggestions.length > 0 && idx >= 0 && idx < suggestions.length) {
        pickSuggestion(suggestions[idx]);
      } else {
        handleAddProperty();
      }
      return;
    }
    if (e.key === "Escape") {
      setAddingProp(false);
      setNewPropKey("");
      setNewPropType("text");
      setAddPropHighlight(0);
    }
  }

  function onNewPropKeyInput(value: string) {
    setNewPropKey(value);
    setAddPropHighlight(0);
    // Auto-select type from registry when the user picks an existing key
    const registryType = getPropertyType(value.trim());
    if (registryType !== "auto") {
      setNewPropType(registryType);
    }
  }

  // Picking a suggestion (click or Enter on highlight) commits the add
  // immediately — no second Enter required.
  function pickSuggestion(key: string) {
    setNewPropKey(key);
    setAddPropHighlight(0);
    handleAddProperty(key);
  }

  async function loadPropertyKeysForAutocomplete() {
    try {
      const keys = await ipc.getAllPropertyKeys();
      const filtered = keys.filter((k) => !k.startsWith("file."));
      // Always include standard properties (in canonical order) plus any custom ones
      const custom = filtered.filter((k) => !KNOWN_FIELDS.has(k)).sort();
      setAllPropKeys([...KNOWN_FIELDS_ORDERED, ...custom]);
    } catch {
      setAllPropKeys([...KNOWN_FIELDS_ORDERED]);
    }
  }

  // ── Hamburger menu ────────────────────────────────────
  const [fileMenu, setFileMenu] = createSignal<{ x: number; y: number } | null>(null);
  let cleanupFileMenu: (() => void) | undefined;

  function openFileMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (cleanupFileMenu) {
      cleanupFileMenu();
      cleanupFileMenu = undefined;
    }
    if (fileMenu()) {
      setFileMenu(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setFileMenu({ x: rect.left, y: rect.bottom + 4 });
    setTimeout(() => {
      const onDocClick = () => {
        setFileMenu(null);
        document.removeEventListener("click", onDocClick);
        cleanupFileMenu = undefined;
      };
      document.addEventListener("click", onDocClick);
      cleanupFileMenu = () => {
        document.removeEventListener("click", onDocClick);
      };
    }, 0);
  }

  async function menuRename() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    const oldName = tab.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    const el = document.createElement("input");
    const newName = prompt("Rename note:", oldName);
    if (!newName || newName === oldName) return;
    try {
      const newPath = await ipc.renameAndUpdateLinks(tab.path, newName);
      closeTab(tab.id);
      openTab({ type: "file", title: newName, path: newPath }, { forceNewTab: true });
    } catch (err) {
      toastError("Rename failed", err);
    }
  }

  async function menuMoveFile() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    try {
      const dest = await dialogOpen({ directory: true, title: "Move file to..." });
      if (!dest) return;
      const newPath = await ipc.moveFile(tab.path, dest as string);
      const name = newPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? tab.title;
      closeTab(tab.id);
      openTab({ type: "file", title: name, path: newPath }, { forceNewTab: true });
    } catch (err) {
      toastError("Move failed", err);
    }
  }

  async function menuBookmark() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    try {
      const name = tab.title.replace(/\.[^.]+$/, "");
      await ipc.addBookmark({ type: "Note", data: { path: tab.path, name } });
    } catch (err) {
      toastError("Bookmark failed", err);
    }
  }

  async function menuMerge() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    const targetName = prompt("Merge entire file with (note name):");
    if (!targetName) return;
    try {
      const targetPath = await ipc.resolveWikilink(targetName);
      if (!targetPath) {
        toastWarning("Note not found: " + targetName);
        return;
      }
      await ipc.mergeNotes([tab.path], targetPath);
      closeTab(tab.id);
      openTab({ type: "file", title: targetName, path: targetPath }, { forceNewTab: true });
    } catch (err) {
      toastError("Merge failed", err);
    }
  }

  function menuExport() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    document.dispatchEvent(
      new CustomEvent("inkycap:export-dialog", { detail: { path: tab.path } }),
    );
  }

  function menuFind() {
    setFileMenu(null);
    document.dispatchEvent(new CustomEvent("inkycap:editor-find"));
  }

  function menuReplace() {
    setFileMenu(null);
    document.dispatchEvent(new CustomEvent("inkycap:editor-replace"));
  }

  async function menuShowInExplorer() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    try {
      await ipc.showInExplorer(tab.path);
    } catch (err) {
      toastError("Show in explorer failed", err);
    }
  }

  function menuShowInFileTree() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    document.dispatchEvent(
      new CustomEvent("inkycap:reveal-in-tree", { detail: tab.path }),
    );
  }

  async function menuDelete() {
    setFileMenu(null);
    const tab = activeFileTab();
    if (!tab) return;
    const confirmed = await ask("Delete this file permanently?", {
      title: "Delete file",
      kind: "warning",
    });
    if (!confirmed) return;
    try {
      await ipc.deleteFile(tab.path);
      closeTab(tab.id);
    } catch (err) {
      toastError("Delete failed", err);
    }
  }

  return (
    <div class="right-panel">
      {/* Tab bar — always visible so the collapse toggle is accessible */}
      <div class="right-panel__tabs">
        <Show when={activeFileTab()}>
          <button
            class="right-panel__tab"
            onClick={openFileMenu}
            title="File actions"
            aria-label="File actions"
          >
            <EllipsisVertical size={16} />
          </button>
          <button
            class={`right-panel__tab${activePanel() === "outline" ? " right-panel__tab--active" : ""}`}
            onClick={() => setActivePanel("outline")}
            title="Outline"
            aria-label="Outline"
          >
            <TableOfContents size={16} />
          </button>
          <button
            class={`right-panel__tab${activePanel() === "properties" ? " right-panel__tab--active" : ""}`}
            onClick={() => setActivePanel("properties")}
            title="Properties"
            aria-label="Properties"
          >
            <NotebookTabs size={16} />
          </button>
          <button
            class={`right-panel__tab${activePanel() === "links" ? " right-panel__tab--active" : ""}`}
            onClick={() => setActivePanel("links")}
            title="Links"
            aria-label="Links"
          >
            <Link size={16} />
          </button>
          <button
            class={`right-panel__tab${activePanel() === "references" ? " right-panel__tab--active" : ""}`}
            onClick={() => setActivePanel("references")}
            title="References"
            aria-label="References"
          >
            <Quote size={16} />
          </button>
          <button
            class="right-panel__tab"
            onClick={() => {
              const tab = activeFileTab();
              if (tab) {
                const name = tab.title.replace(/\.[^.]+$/, "");
                openTab(
                  { type: "flow", title: `Flow: ${name}`, path: tab.path },
                  { forceNewTab: true },
                );
              }
            }}
            title="Flow view"
            aria-label="Flow view"
          >
            <BrainCircuit size={16} />
          </button>
        </Show>
      </div>

      <Show
        when={activeFileTab()}
        fallback={<p class="sidebar-hint">No file selected</p>}
      >

        <div class="right-panel__tab-content">
          {/* Properties tab */}
          <Show when={activePanel() === "properties"}>
            <div class="right-panel__section">
              <Show when={metadata()}>
                {(meta) => (
                  <div class="properties-list">
                    <For each={sortedPropertyEntries()}>
                      {([key, value]) => {
                        const ty = () => {
                          const declared = getPropertyType(key);
                          if (declared !== "auto") return declared;
                          return KNOWN_FIELD_TYPES[key] ?? "auto";
                        };
                        const isDragging = () => draggingKey() === key;
                        const dropAbove = () =>
                          dragOverKey() === key && dropPosition() === "before";
                        const dropBelow = () =>
                          dragOverKey() === key && dropPosition() === "after";
                        return (
                          <div
                            class={
                              `property-row${KNOWN_FIELDS.has(key) ? " property-row--system" : ""}` +
                              `${isDragging() ? " property-row--dragging" : ""}` +
                              `${dropAbove() ? " property-row--drop-above" : ""}` +
                              `${dropBelow() ? " property-row--drop-below" : ""}`
                            }
                            onDragOver={(e) => handleDragOver(e, key)}
                            onDrop={(e) => handleDrop(e, key)}
                            onDragLeave={() => {
                              if (dragOverKey() === key) setDragOverKey(null);
                            }}
                          >
                            <div class="property-row__name">
                              <span
                                class="property-row__icon property-row__drag-handle"
                                title={`Type: ${propertyTypeLabel(ty())} \u2014 drag to reorder`}
                                draggable={true}
                                onDragStart={(e) => handleDragStart(e, key)}
                                onDragEnd={handleDragEnd}
                              >
                                <Dynamic component={propertyTypeIcon(ty())} size={14} />
                              </span>
                              <span class="property-row__key">{key}</span>
                            </div>
                            <div class="property-row__value-cell">
                              <PropertyEditor
                                propKey={key}
                                value={value}
                                onSave={handlePropertySave}
                              />
                            </div>
                            <button
                              class="property-row__type-btn"
                              title="Property options"
                              onClick={(e) => openRowMenu(e, key)}
                            >
                              {"\u22EE"}
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                )}
              </Show>

              <Show
                when={addingProp()}
                fallback={
                  <button
                    class="right-panel__add-btn"
                    onClick={() => { loadPropertyKeysForAutocomplete(); setAddingProp(true); }}
                  >
                    + Add property
                  </button>
                }
              >
                <div class="right-panel__add-form">
                  <input
                    class="property-editor__input"
                    type="text"
                    placeholder="Property name..."
                    value={newPropKey()}
                    onInput={(e) => onNewPropKeyInput(e.currentTarget.value)}
                    onKeyDown={handleAddKeyDown}
                    onBlur={() => setTimeout(() => setAddPropHighlight(-1), 100)}
                    ref={(el) => setTimeout(() => el.focus(), 0)}
                  />
                  <Show when={addPropSuggestions().length > 0}>
                    <div class="add-prop-suggestions">
                      <For each={addPropSuggestions()}>
                        {(key, idx) => (
                          <button
                            type="button"
                            class={`add-prop-suggestions__item${addPropHighlight() === idx() ? " add-prop-suggestions__item--active" : ""}`}
                            onMouseDown={(e) => {
                              // mousedown so the click commits before the
                              // input's blur handler clears highlight state.
                              e.preventDefault();
                              pickSuggestion(key);
                            }}
                            onMouseEnter={() => setAddPropHighlight(idx())}
                          >
                            <span class="add-prop-suggestions__icon">
                              <Dynamic
                                component={propertyTypeIcon(
                                  KNOWN_FIELD_TYPES[key] ?? getPropertyType(key),
                                )}
                                size={12}
                              />
                            </span>
                            <span>{key}</span>
                            <Show when={KNOWN_FIELDS.has(key)}>
                              <span class="add-prop-suggestions__badge">system</span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={!KNOWN_FIELDS.has(newPropKey().trim()) && getPropertyType(newPropKey().trim()) === "auto"}>
                    <select
                      class="property-editor__type-select"
                      value={newPropType()}
                      onChange={(e) => setNewPropType(e.currentTarget.value as PropertyType)}
                    >
                      <For each={PROPERTY_TYPE_OPTIONS.filter((t) => t !== "auto")}>
                        {(ty) => (
                          <option value={ty}>{propertyTypeLabel(ty)}</option>
                        )}
                      </For>
                    </select>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>

          {/* Outline tab */}
          <Show when={activePanel() === "outline"}>
            <OutlinePanel />
          </Show>

          {/* Links tab */}
          <Show when={activePanel() === "links"}>
            <Show when={!indexReady()}>
              <p class="sidebar-hint">{"Indexing vault\u2026"}</p>
            </Show>
            {/* Backlinks section */}
            <div class="right-panel__section">
              <div class="right-panel__heading">
                Backlinks
                <Show when={backlinks()?.length}>
                  <span class="right-panel__count"> ({backlinks()!.length})</span>
                </Show>
              </div>
              <For each={backlinks()}>
                {(link) => (
                  <div>
                    <div
                      class="sidebar-item"
                      onClick={() => openLinkedFile(link)}
                    >
                      <span class="sidebar-item__icon" innerHTML={`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H4.5a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 2z"/><polyline points="9.5 2 9.5 5.5 13 5.5"/></svg>`} />
                      <span class="sidebar-item__label">{link.name}</span>
                    </div>
                    <Show when={link.context}>
                      <div class="link-context">{link.context}</div>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={backlinks()?.length === 0}>
                <p class="sidebar-hint">No backlinks</p>
              </Show>
            </div>

            {/* Forward links section */}
            <div class="right-panel__section">
              <div class="right-panel__heading">
                Forward Links
                <Show when={forwardLinks()?.length}>
                  <span class="right-panel__count">
                    {" "}({forwardLinks()!.length})
                  </span>
                </Show>
              </div>
              <For each={forwardLinks()}>
                {(link) => (
                  <div class={link.resolved ? "" : "link--unresolved"}>
                    <div
                      class="sidebar-item"
                      onClick={() => link.resolved ? openLinkedFile(link) : createUnresolvedNote(link.target)}
                    >
                      <span class="sidebar-item__icon" innerHTML={link.resolved
                        ? `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H4.5a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 2z"/><polyline points="9.5 2 9.5 5.5 13 5.5"/></svg>`
                        : `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2H4.5a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 2z" stroke-dasharray="2.5 2"/><polyline points="9.5 2 9.5 5.5 13 5.5" stroke-dasharray="2.5 2"/></svg>`
                      } />
                      <span class="sidebar-item__label">{link.name}</span>
                      <Show when={!link.resolved}>
                        <button
                          class="link__create-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            createUnresolvedNote(link.target);
                          }}
                        >
                          create
                        </button>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
              <Show when={forwardLinks()?.length === 0}>
                <p class="sidebar-hint">No forward links</p>
              </Show>
            </div>
          </Show>

          {/* References tab */}
          <Show when={activePanel() === "references"}>
            <ReferencesPanel />
          </Show>
        </div>
      </Show>

      {/* File actions hamburger menu */}
      <Show when={fileMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px`, position: "fixed" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button class="context-menu__item" onClick={menuRename}>
              Rename...
            </button>
            <button class="context-menu__item" onClick={menuMoveFile}>
              Move file to...
            </button>
            <button class="context-menu__item" onClick={menuBookmark}>
              Bookmark...
            </button>
            <button class="context-menu__item" onClick={menuMerge}>
              Merge entire file with...
            </button>
            <div class="context-menu__separator" />
            <button class="context-menu__item" onClick={menuExport}>
              Export...
            </button>
            <div class="context-menu__separator" />
            <button class="context-menu__item" onClick={menuFind}>
              Find...
            </button>
            <button class="context-menu__item" onClick={menuReplace}>
              Replace...
            </button>
            <div class="context-menu__separator" />
            <button class="context-menu__item" onClick={menuShowInFileTree}>
              Show in file tree
            </button>
            <button class="context-menu__item" onClick={menuShowInExplorer}>
              Show in system explorer
            </button>
            <div class="context-menu__separator" />
            <button class="context-menu__item context-menu__item--danger" onClick={menuDelete}>
              Delete file
            </button>
          </div>
        )}
      </Show>

      <Show when={rowMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px`, position: "fixed" }}
            onClick={(e) => e.stopPropagation()}
          >
            <Show when={!KNOWN_FIELDS.has(menu().key)}>
              <div
                class="context-menu__item context-menu__item--submenu"
                onMouseEnter={() =>
                  setRowMenu({ ...menu(), typeSubmenuOpen: true })
                }
                onMouseLeave={() =>
                  setRowMenu({ ...menu(), typeSubmenuOpen: false })
                }
              >
                Property type
                <span class="context-menu__chevron">{"\u25B8"}</span>
                <Show when={menu().typeSubmenuOpen}>
                  <div
                    class={`context-menu context-menu--submenu ${menu().openLeft ? "context-menu--submenu-left" : ""}`}
                  >
                    <For each={PROPERTY_TYPE_OPTIONS}>
                      {(ty) => (
                        <button
                          class="context-menu__item"
                          onClick={() => handleSetRowPropertyType(menu().key, ty)}
                        >
                          {propertyTypeLabel(ty)}
                          <Show when={getPropertyType(menu().key) === ty}>
                            <span class="context-menu__check">{"\u2713"}</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => handleRemoveProperty(menu().key)}
            >
              Remove
            </button>
          </div>
        )}
      </Show>
    </div>
  );
};

export default RightPanel;

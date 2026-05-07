import {
  Component,
  createMemo,
  createSignal,
  createResource,
  For,
  Show,
  onCleanup,
} from "solid-js";
import {
  Library,
  FolderTree,
  Tags,
  Search,
  Bookmark,
  Plus,
  Hash,
  ChevronRight,
  ChevronDown,
  FileText,
  NotebookTabs,
  Filter,
} from "lucide-solid";
import RuleIcon from "./RuleIcon";
import type { CollectionInfo, FileTreeNode, PropertyType } from "../lib/types";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask, message } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import { vaultInfo, fileTreeVersion, propertyVersion, bumpPropertyVersion } from "../stores/vault";
import { openTab, closeTab, tabs } from "../stores/tabs";
import {
  PROPERTY_TYPE_OPTIONS,
  propertyTypeLabel,
  reloadPropertyTypes,
  allPropertyTypes,
} from "../stores/propertyTypes";
import SearchPanel from "./SearchPanel";
import BookmarksPanel from "./BookmarksPanel";
import type { SidebarMode } from "./VerticalToolbar";
import { toastError, toastSuccess } from "../stores/toasts";

interface LeftSidebarProps {
  mode: () => SidebarMode;
  setMode: (m: SidebarMode) => void;
}

const TYPST_EXTS = new Set([".typ"]);
const HIDDEN_NAMES = new Set([".inkycap"]);

function filterTypstFiles(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes
    .filter((n) => !HIDDEN_NAMES.has(n.name))
    .map((n) => {
      if (n.is_dir) {
        const children = n.children ? filterTypstFiles(n.children) : [];
        if (children.length === 0) return null;
        return { ...n, children };
      }
      const ext = n.name.lastIndexOf(".") >= 0 ? n.name.slice(n.name.lastIndexOf(".")) : "";
      return TYPST_EXTS.has(ext) ? n : null;
    })
    .filter((n): n is FileTreeNode => n !== null);
}

const LeftSidebar: Component<LeftSidebarProps> = (props) => {
  const mode = props.mode;
  const setMode = props.setMode;
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [typstOnly, setTypstOnly] = createSignal(true);

  // Context menu state
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    collection: CollectionInfo;
  } | null>(null);

  // Rename state
  const [renamingPath, setRenamingPath] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal("");

  const [collections, { refetch: refetchCollections }] = createResource(
    () => ({ info: vaultInfo(), tick: refreshTick(), version: fileTreeVersion() }),
    async ({ info }) => {
      if (!info) return [];
      return ipc.listCollections();
    },
  );

  const [fileTree, { refetch: refetchFileTree }] = createResource(
    () => ({ info: vaultInfo(), tick: refreshTick(), version: fileTreeVersion() }),
    async ({ info }) => {
      if (!info) return [];
      return ipc.getFileTree();
    },
  );

  const filteredFileTree = createMemo(() => {
    const tree = fileTree();
    if (!tree) return [];
    return typstOnly() ? filterTypstFiles(tree) : tree;
  });

  const [vaultIndex, { refetch: refetchVaultIndex }] = createResource(
    () => ({ info: vaultInfo(), tick: refreshTick(), pv: propertyVersion() }),
    async ({ info }) => {
      if (!info) return null;
      return ipc.getVaultIndex();
    },
  );

  // Refetch collections when the metadata editor saves a .collection file
  const onCollectionsChanged = () => refetchCollections();
  document.addEventListener("inkycap:collections-changed", onCollectionsChanged);
  onCleanup(() => document.removeEventListener("inkycap:collections-changed", onCollectionsChanged));

  // Context menu state for tag and property items. Only one is ever open
  // at a time; the sidebar-level click-outside handler closes whichever is.
  type TagMenuState = { x: number; y: number; tag: string };
  type PropMenuState = {
    x: number;
    y: number;
    key: string;
    typeSubmenuOpen: boolean;
    openLeft: boolean;
  };
  const [tagMenu, setTagMenu] = createSignal<TagMenuState | null>(null);
  const [propMenu, setPropMenu] = createSignal<PropMenuState | null>(null);

  // Inline rename state for tags / property keys.
  const [renamingTag, setRenamingTag] = createSignal<string | null>(null);
  const [tagRenameValue, setTagRenameValue] = createSignal("");
  const [renamingProperty, setRenamingProperty] = createSignal<string | null>(null);
  const [propertyRenameValue, setPropertyRenameValue] = createSignal("");

  function openSearchFor(query: string) {
    setMode("search");
    document.dispatchEvent(
      new CustomEvent("inkycap:open-search", { detail: { query } }),
    );
  }

  // Approximate menu size. The submenu adds another ~200x220 to the
  // right, but we only need to keep the top-level menu inside the
  // viewport — the submenu reflows naturally once its parent fits.
  const MENU_W = 180;
  const MENU_H = 160;
  function clampMenuPos(x: number, y: number) {
    const maxX = Math.max(8, window.innerWidth - MENU_W - 8);
    const maxY = Math.max(8, window.innerHeight - MENU_H - 8);
    return { x: Math.min(x, maxX), y: Math.min(y, maxY) };
  }

  function handleTagContext(e: MouseEvent, tag: string) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    setFileContextMenu(null);
    setPropMenu(null);
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    setTagMenu({ x, y, tag });
  }

  function handlePropertyContext(e: MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    setFileContextMenu(null);
    setTagMenu(null);
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    const SUBMENU_W = 180;
    const openLeft = x + MENU_W + SUBMENU_W > window.innerWidth - 8;
    setPropMenu({ x, y, key, typeSubmenuOpen: false, openLeft });
  }

  function startTagRename(tag: string) {
    setTagMenu(null);
    setRenamingTag(tag);
    setTagRenameValue(tag);
  }

  async function commitTagRename() {
    const oldTag = renamingTag();
    const newTag = tagRenameValue().trim();
    setRenamingTag(null);
    if (!oldTag || !newTag || oldTag === newTag) return;

    const existing = vaultIndex()?.tags.find(([t]) => t === newTag);
    if (existing) {
      const ok = await ask(
        `A tag already exists with the name "${newTag}". Renaming "${oldTag}" will merge tags into "${newTag}". Continue?`,
        { title: "Merge tags", kind: "warning" },
      );
      if (!ok) return;
    }

    try {
      await ipc.renameTag(oldTag, newTag);
      refresh();
      refetchVaultIndex();
    } catch (err) {
      toastError("Failed to rename tag", err);
    }
  }

  async function handleDeleteTag(tag: string) {
    setTagMenu(null);
    const ok = await ask(
      `Delete tag "${tag}" from every note that uses it? This cannot be undone.`,
      { title: "Delete tag", kind: "warning" },
    );
    if (!ok) return;
    try {
      await ipc.deleteTag(tag);
      refresh();
      refetchVaultIndex();
    } catch (err) {
      toastError("Failed to delete tag", err);
    }
  }

  function startPropertyRename(key: string) {
    setPropMenu(null);
    setRenamingProperty(key);
    setPropertyRenameValue(key);
  }

  async function commitPropertyRename() {
    const oldKey = renamingProperty();
    const newKey = propertyRenameValue().trim();
    setRenamingProperty(null);
    if (!oldKey || !newKey || oldKey === newKey) return;

    const existing = vaultIndex()?.property_keys.find(([k]) => k === newKey);
    if (existing) {
      const oldType = allPropertyTypes()[oldKey];
      const newType = allPropertyTypes()[newKey];
      const typeConflict = oldType && newType && oldType !== newType;
      const msg = typeConflict
        ? `A property already exists with the name "${newKey}" (type: ${propertyTypeLabel(newType)}). Renaming "${oldKey}" (type: ${propertyTypeLabel(oldType)}) will merge properties into "${newKey}" using the "${propertyTypeLabel(newType)}" type. Values may need manual correction. Continue?`
        : `A property already exists with the name "${newKey}". Renaming "${oldKey}" will merge properties into "${newKey}". Continue?`;
      const ok = await ask(msg, { title: "Merge properties", kind: "warning" });
      if (!ok) return;
    }

    try {
      await ipc.renamePropertyKey(oldKey, newKey);
      await reloadPropertyTypes();
      bumpPropertyVersion();
      refresh();
      refetchVaultIndex();
    } catch (err) {
      toastError("Failed to rename property", err);
    }
  }

  async function handleDeleteProperty(key: string) {
    setPropMenu(null);
    const ok = await ask(
      `Delete property "${key}" from every note that uses it? This cannot be undone.`,
      { title: "Delete property", kind: "warning" },
    );
    if (!ok) return;
    try {
      await ipc.deletePropertyKey(key);
      await reloadPropertyTypes();
      bumpPropertyVersion();
      refresh();
      refetchVaultIndex();
    } catch (err) {
      toastError("Failed to delete property", err);
    }
  }

  async function setPropertyTypeFor(key: string, ty: PropertyType) {
    setPropMenu(null);
    try {
      await ipc.setPropertyType(key, ty);
      await reloadPropertyTypes();
      refresh();
    } catch (err) {
      toastError("Failed to change property type", err);
    }
  }

  function openCollection(col: CollectionInfo) {
    openTab({
      type: "collection",
      title: col.name,
      path: col.path,
    });
  }

  function openFile(node: FileTreeNode, e?: MouseEvent) {
    if (node.is_dir) return;
    const forceNewTab = !!(e && (e.ctrlKey || e.metaKey));
    if (node.name.toLowerCase().endsWith(".collection")) {
      openTab(
        {
          type: "collection",
          title: node.name.replace(/\.collection$/i, ""),
          path: node.path,
        },
        { forceNewTab },
      );
      return;
    }
    openTab(
      { type: "file", title: node.name, path: node.path },
      { forceNewTab },
    );
  }

  function openFileInNewTab(node: FileTreeNode) {
    if (node.is_dir) return;
    if (node.name.toLowerCase().endsWith(".collection")) {
      openTab(
        {
          type: "collection",
          title: node.name.replace(/\.collection$/i, ""),
          path: node.path,
        },
        { forceNewTab: true },
      );
      return;
    }
    openTab(
      { type: "file", title: node.name, path: node.path },
      { forceNewTab: true },
    );
  }

  function refresh() {
    setRefreshTick((t) => t + 1);
  }

  // ── Collection CRUD ──

  async function createCollection() {
    const info = vaultInfo();
    if (!info) return;
    const name = prompt("New collection name:");
    if (!name?.trim()) return;
    try {
      const col = await ipc.createCollectionFile(name.trim(), info.path);
      refresh();
      openCollection(col);
    } catch (e) {
      toastError("Failed to create collection", e);
    }
  }

  async function deleteCollection(col: CollectionInfo) {
    setContextMenu(null);
    const confirmed = await ask(`Delete collection "${col.name}"?`, { title: "Delete collection", kind: "warning" });
    if (!confirmed) return;
    try {
      await ipc.deleteCollectionFile(col.path);
      // Close any open tab for this collection
      const openCollTab = tabs.find(
        (t) => t.type === "collection" && t.path === col.path,
      );
      if (openCollTab) closeTab(openCollTab.id);
      refresh();
    } catch (e) {
      toastError("Failed to delete collection", e);
    }
  }

  function startRename(col: CollectionInfo) {
    setContextMenu(null);
    setRenamingPath(col.path);
    setRenameValue(col.name);
  }

  async function commitRename() {
    const path = renamingPath();
    const newName = renameValue().trim();
    setRenamingPath(null);
    if (!path || !newName) return;
    try {
      await ipc.renameCollectionFile(path, newName);
      refresh();
    } catch (e) {
      toastError("Failed to rename collection", e);
    }
  }

  function handleCollectionContext(e: MouseEvent, col: CollectionInfo) {
    e.preventDefault();
    // clampMenuPos is defined below; forward-reference is fine in JS.
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    setContextMenu({ x, y, collection: col });
  }

  // ── File tree CRUD ──

  // File tree context menu state
  const [fileContextMenu, setFileContextMenu] = createSignal<{
    x: number;
    y: number;
    node: FileTreeNode;
  } | null>(null);

  // File tree rename state
  const [fileRenamingPath, setFileRenamingPath] = createSignal<string | null>(null);
  const [fileRenameValue, setFileRenameValue] = createSignal("");

  function handleFileContext(e: MouseEvent, node: FileTreeNode) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    setFileContextMenu({ x, y, node });
  }

  async function createNewFile(parentFolder: string) {
    setFileContextMenu(null);
    const name = prompt("New note name:");
    if (!name?.trim()) return;
    try {
      const newPath = await ipc.createFile(name.trim(), parentFolder);
      refresh();
      // Derive the title from the canonical path the backend returns; the
      // user-typed `name` may not include the extension the backend appends.
      const title = newPath.split(/[/\\]/).pop() ?? name.trim();
      openTab(
        {
          type: "file",
          title,
          path: newPath,
        },
        { forceNewTab: true },
      );
    } catch (e) {
      toastError("Failed to create file", e);
    }
  }

  async function createNewFolder(parentFolder: string) {
    setFileContextMenu(null);
    const name = prompt("New folder name:");
    if (!name?.trim()) return;
    try {
      await ipc.createFolder(name.trim(), parentFolder);
      refresh();
    } catch (e) {
      toastError("Failed to create folder", e);
    }
  }

  function startFileRename(node: FileTreeNode) {
    setFileContextMenu(null);
    setFileRenamingPath(node.path);
    // Show name without extension for files
    const displayName = node.is_dir
      ? node.name
      : node.name.replace(/\.[^.]+$/, "");
    setFileRenameValue(displayName);
  }

  async function commitFileRename() {
    const oldPath = fileRenamingPath();
    const newName = fileRenameValue().trim();
    setFileRenamingPath(null);
    if (!oldPath || !newName) return;

    try {
      const settings = await ipc.getSettings();
      if (settings.files.auto_update_links_on_rename) {
        await ipc.renameAndUpdateLinks(oldPath, newName);
      } else {
        await ipc.renameFile(oldPath, newName);
      }
      refresh();
    } catch (e) {
      toastError("Failed to rename", e);
    }
  }

  async function handleDeleteFile(node: FileTreeNode) {
    setFileContextMenu(null);
    const settings = await ipc.getSettings();
    if (settings.files.confirm_before_delete) {
      const confirmed = await ask(
        `Move "${node.name}" to trash?`,
        { title: "Delete", kind: "warning" },
      );
      if (!confirmed) return;
    }
    try {
      if (node.is_dir) {
        await ipc.deleteFolder(node.path);
      } else {
        await ipc.deleteFile(node.path);
        // Close open tab for this file
        const openFileTab = tabs.find(
          (t) => t.type === "file" && t.path === node.path,
        );
        if (openFileTab) closeTab(openFileTab.id);
      }
      refresh();
    } catch (e) {
      toastError("Failed to delete", e);
    }
  }

  async function createNewNoteAtRoot() {
    const info = vaultInfo();
    if (!info) return;
    await createNewFile(info.path);
  }

  // Close context menus on click outside
  function handleDocClick() {
    setContextMenu(null);
    setFileContextMenu(null);
    setTagMenu(null);
    setPropMenu(null);
  }

  if (typeof document !== "undefined") {
    document.addEventListener("click", handleDocClick);
    onCleanup(() => document.removeEventListener("click", handleDocClick));
  }

  return (
    <div class="left-sidebar">
      <div class="left-sidebar__mode-bar">
        <button
          class={`left-sidebar__mode-btn ${mode() === "filetree" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("filetree")}
          title="File Tree"
          aria-label="File Tree"
        >
          <FolderTree size={16} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "collections" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("collections")}
          title="Collections"
          aria-label="Collections"
        >
          <Library size={16} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "tags" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("tags")}
          title="Tags"
          aria-label="Tags"
        >
          <Tags size={16} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "properties" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("properties")}
          title="Properties"
          aria-label="Properties"
        >
          <NotebookTabs size={16} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "bookmarks" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("bookmarks")}
          title="Bookmarks"
          aria-label="Bookmarks"
        >
          <Bookmark size={16} />
        </button>
        <button
          class={`left-sidebar__mode-btn ${mode() === "search" ? "left-sidebar__mode-btn--active" : ""}`}
          onClick={() => setMode("search")}
          title="Search (Ctrl+Shift+F)"
          aria-label="Search"
        >
          <Search size={16} />
        </button>
      </div>
      <div class="left-sidebar__content">
        <Show when={mode() === "collections"}>
          <div class="left-sidebar__section-header">
            <span>Collections</span>
            <button
              class="left-sidebar__add-btn"
              onClick={createCollection}
              title="New collection"
              aria-label="New collection"
            >
              <Plus size={14} />
            </button>
          </div>
          <Show
            when={!collections.loading}
            fallback={<p class="sidebar-hint">Loading...</p>}
          >
            <For
              each={collections()}
              fallback={<p class="sidebar-hint">No collections found</p>}
            >
              {(col) => (
                <Show
                  when={renamingPath() === col.path}
                  fallback={
                    <div
                      class="sidebar-item"
                      onClick={() => openCollection(col)}
                      onContextMenu={(e) => handleCollectionContext(e, col)}
                    >
                      <span class="sidebar-item__icon">
                        <RuleIcon iconEmoji={col.icon ?? "lucide:folder-pen"} name={col.name} size={14} />
                      </span>
                      <span class="sidebar-item__label">{col.name}</span>
                      <Show when={col.view_count > 1}>
                        <span class="sidebar-item__badge">{col.view_count}</span>
                      </Show>
                    </div>
                  }
                >
                  <div class="sidebar-item sidebar-item--editing">
                    <input
                      class="sidebar-item__rename-input"
                      type="text"
                      value={renameValue()}
                      onInput={(e) => setRenameValue(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingPath(null);
                      }}
                      onBlur={commitRename}
                      ref={(el) => setTimeout(() => el.focus(), 0)}
                    />
                  </div>
                </Show>
              )}
            </For>
          </Show>
        </Show>

        <Show when={mode() === "filetree"}>
          <div class="left-sidebar__section-header">
            <span>Files</span>
            <div class="left-sidebar__header-actions">
              <button
                class={`left-sidebar__filter-btn${typstOnly() ? " left-sidebar__filter-btn--active" : ""}`}
                onClick={() => setTypstOnly((v) => !v)}
                title={typstOnly() ? "Showing .typ files only — click to show all" : "Showing all files — click to filter to .typ only"}
                aria-label="Toggle file filter"
              >
                <Filter size={14} />
              </button>
              <button
                class="left-sidebar__add-btn"
                onClick={createNewNoteAtRoot}
                title="New note"
                aria-label="New note"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
          <Show
            when={!fileTree.loading}
            fallback={<p class="sidebar-hint">Loading...</p>}
          >
            <For each={filteredFileTree()}>
              {(node) => (
                <TreeNode
                  node={node}
                  onOpen={openFile}
                  onContext={handleFileContext}
                  renamingPath={fileRenamingPath()}
                  renameValue={fileRenameValue()}
                  onRenameInput={setFileRenameValue}
                  onRenameCommit={commitFileRename}
                  onRenameCancel={() => setFileRenamingPath(null)}
                />
              )}
            </For>
          </Show>
        </Show>

        <Show when={mode() === "search"}>
          <SearchPanel />
        </Show>

        <Show when={mode() === "tags"}>
          <div class="left-sidebar__section-header">
            <span>Tags</span>
          </div>
          <Show when={vaultIndex()} fallback={<p class="sidebar-hint">Loading...</p>}>
            {(idx) => (
              <For
                each={idx().tags}
                fallback={<p class="sidebar-hint">No tags found</p>}
              >
                {([tag, count]) => (
                  <Show
                    when={renamingTag() === tag}
                    fallback={
                      <div
                        class="sidebar-item"
                        onClick={() => openSearchFor(`tag:${tag}`)}
                        onContextMenu={(e) => handleTagContext(e, tag)}
                      >
                        <span class="sidebar-item__icon">
                          <Hash size={14} />
                        </span>
                        <span class="sidebar-item__label">{tag}</span>
                        <span class="vault-index__count">{count}</span>
                      </div>
                    }
                  >
                    <div class="sidebar-item sidebar-item--editing">
                      <input
                        class="sidebar-item__rename-input"
                        type="text"
                        value={tagRenameValue()}
                        onInput={(e) => setTagRenameValue(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitTagRename();
                          if (e.key === "Escape") setRenamingTag(null);
                        }}
                        onBlur={commitTagRename}
                        ref={(el) => setTimeout(() => el.focus(), 0)}
                      />
                    </div>
                  </Show>
                )}
              </For>
            )}
          </Show>
        </Show>

        <Show when={mode() === "properties"}>
          <div class="left-sidebar__section-header">
            <span>Properties</span>
          </div>
          <Show when={vaultIndex()} fallback={<p class="sidebar-hint">Loading...</p>}>
            {(idx) => (
              <For
                each={idx().property_keys}
                fallback={<p class="sidebar-hint">No properties found</p>}
              >
                {([key, count]) => (
                  <Show
                    when={renamingProperty() === key}
                    fallback={
                      <div
                        class="sidebar-item"
                        onClick={() => openSearchFor(`property:${key}`)}
                        onContextMenu={(e) => handlePropertyContext(e, key)}
                      >
                        <span class="sidebar-item__label">{key}</span>
                        <span class="vault-index__count">{count}</span>
                      </div>
                    }
                  >
                    <div class="sidebar-item sidebar-item--editing">
                      <input
                        class="sidebar-item__rename-input"
                        type="text"
                        value={propertyRenameValue()}
                        onInput={(e) => setPropertyRenameValue(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitPropertyRename();
                          if (e.key === "Escape") setRenamingProperty(null);
                        }}
                        onBlur={commitPropertyRename}
                        ref={(el) => setTimeout(() => el.focus(), 0)}
                      />
                    </div>
                  </Show>
                )}
              </For>
            )}
          </Show>
        </Show>

        <Show when={mode() === "bookmarks"}>
          <div class="left-sidebar__section-header">
            <span>Bookmarks</span>
          </div>
          <BookmarksPanel refreshTick={refreshTick()} />
        </Show>
      </div>

      {/* Context menu for collections */}
      <Show when={contextMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class="context-menu__item"
              onClick={async () => {
                const col = menu().collection;
                setContextMenu(null);
                try {
                  await ipc.addBookmark({
                    type: "Collection",
                    data: { path: col.path, name: col.name },
                  });
                } catch (e) {
                  console.error("Failed to bookmark:", e);
                }
              }}
            >
              Bookmark
            </button>
            <button
              class="context-menu__item"
              onClick={() => startRename(menu().collection)}
            >
              Rename
            </button>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => deleteCollection(menu().collection)}
            >
              Delete
            </button>
          </div>
        )}
      </Show>

      {/* Context menu for tags */}
      <Show when={tagMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class="context-menu__item"
              onClick={() => startTagRename(menu().tag)}
            >
              Rename
            </button>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => handleDeleteTag(menu().tag)}
            >
              Delete
            </button>
          </div>
        )}
      </Show>

      {/* Context menu for property keys */}
      <Show when={propMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              class="context-menu__item context-menu__item--submenu"
              onMouseEnter={() =>
                setPropMenu({ ...menu(), typeSubmenuOpen: true })
              }
              onMouseLeave={() =>
                setPropMenu({ ...menu(), typeSubmenuOpen: false })
              }
            >
              Property type
              <span class="context-menu__chevron">{"\u25B8"}</span>
              <Show when={menu().typeSubmenuOpen}>
                <div
                  class={`context-menu context-menu--submenu ${menu().openLeft ? "context-menu--submenu-left" : ""}`}
                >
                  <For each={PROPERTY_TYPE_OPTIONS}>
                    {(ty) => {
                      const current = () => allPropertyTypes()[menu().key] ?? "auto";
                      return (
                        <button
                          class="context-menu__item"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPropertyTypeFor(menu().key, ty);
                          }}
                        >
                          {propertyTypeLabel(ty)}
                          <Show when={current() === ty}>
                            <span class="context-menu__check">{"\u2713"}</span>
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
            <button
              class="context-menu__item"
              onClick={() => startPropertyRename(menu().key)}
            >
              Rename
            </button>
            <button
              class="context-menu__item context-menu__item--danger"
              onClick={() => handleDeleteProperty(menu().key)}
            >
              Delete
            </button>
          </div>
        )}
      </Show>

      {/* Context menu for file tree */}
      <Show when={fileContextMenu()}>
        {(menu) => {
          const node = menu().node;
          // Get folder path for "new file/folder" actions
          const folderPath = node.is_dir ? node.path : node.path.replace(/\/[^/]+$/, "");
          return (
            <div
              class="context-menu"
              style={{
                left: `${menu().x}px`,
                top: `${menu().y}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <Show when={!node.is_dir}>
                <button
                  class="context-menu__item"
                  onClick={() => {
                    setFileContextMenu(null);
                    openFileInNewTab(node);
                  }}
                >
                  Open in new tab
                </button>
                <button
                  class="context-menu__item"
                  onClick={() => {
                    setFileContextMenu(null);
                    const label = `note-${Date.now()}`;
                    const win = new WebviewWindow(label, {
                      url: `index.html?path=${encodeURIComponent(node.path)}`,
                      title: node.name,
                      width: 900,
                      height: 700,
                    });
                    win.once("tauri://error", (e) => {
                      console.error("Failed to open new window:", e);
                    });
                  }}
                >
                  Open in new window
                </button>
                <div class="context-menu__separator" />
              </Show>
              <button
                class="context-menu__item"
                onClick={() => createNewFile(folderPath)}
              >
                New File
              </button>
              <button
                class="context-menu__item"
                onClick={() => createNewFolder(folderPath)}
              >
                New Folder
              </button>
              <Show when={!node.is_dir}>
                <button
                  class="context-menu__item"
                  onClick={async () => {
                    setFileContextMenu(null);
                    try {
                      await ipc.addBookmark({
                        type: "Note",
                        data: {
                          path: node.path,
                          name: node.name.replace(/\.[^.]+$/, ""),
                        },
                      });
                    } catch (e) {
                      console.error("Failed to bookmark:", e);
                    }
                  }}
                >
                  Bookmark
                </button>
              </Show>
              <div class="context-menu__separator" />
              <button
                class="context-menu__item"
                onClick={() => startFileRename(node)}
              >
                Rename
              </button>
              <button
                class="context-menu__item context-menu__item--danger"
                onClick={() => handleDeleteFile(node)}
              >
                Delete
              </button>
            </div>
          );
        }}
      </Show>
    </div>
  );
};

const TreeNode: Component<{
  node: FileTreeNode;
  onOpen: (node: FileTreeNode, e?: MouseEvent) => void;
  onContext: (e: MouseEvent, node: FileTreeNode) => void;
  renamingPath: string | null;
  renameValue: string;
  onRenameInput: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  depth?: number;
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const depth = props.depth ?? 0;

  const isRenaming = () => props.renamingPath === props.node.path;

  return (
    <div>
      <Show
        when={isRenaming()}
        fallback={
          <div
            class={`sidebar-item ${props.node.is_dir ? "sidebar-item--dir" : ""}`}
            style={{ "padding-left": `${depth * 16 + 8}px` }}
            onClick={(e) => {
              if (props.node.is_dir) {
                setExpanded(!expanded());
              } else {
                props.onOpen(props.node, e);
              }
            }}
            onContextMenu={(e) => props.onContext(e, props.node)}
          >
            <span class="sidebar-item__icon">
              {props.node.is_dir ? (
                expanded() ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )
              ) : (
                <FileText size={14} />
              )}
            </span>
            <span class="sidebar-item__label">{props.node.name}</span>
          </div>
        }
      >
        <div
          class="sidebar-item sidebar-item--editing"
          style={{ "padding-left": `${depth * 16 + 8}px` }}
        >
          <input
            class="sidebar-item__rename-input"
            type="text"
            value={props.renameValue}
            onInput={(e) => props.onRenameInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onRenameCommit();
              if (e.key === "Escape") props.onRenameCancel();
            }}
            onBlur={props.onRenameCommit}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
        </div>
      </Show>
      <Show when={expanded() && props.node.children}>
        <For each={props.node.children}>
          {(child) => (
            <TreeNode
              node={child}
              onOpen={props.onOpen}
              onContext={props.onContext}
              renamingPath={props.renamingPath}
              renameValue={props.renameValue}
              onRenameInput={props.onRenameInput}
              onRenameCommit={props.onRenameCommit}
              onRenameCancel={props.onRenameCancel}
              depth={depth + 1}
            />
          )}
        </For>
      </Show>
    </div>
  );
};

export default LeftSidebar;

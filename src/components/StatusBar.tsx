import { Component, Show, For, createSignal, createMemo } from "solid-js";
import { ArchiveRestore, Archive, Check } from "lucide-solid";
import { vaultInfo, vaultRegistry, openVault } from "../stores/vault";
import { wordCountStats } from "../editor/typst-decorations/word-count";
import { getActiveTab } from "../stores/tabs";

const StatusBar: Component = () => {
  const isFileTab = () => getActiveTab()?.type === "file";
  const stats = wordCountStats;

  const displayName = createMemo(() => {
    const info = vaultInfo();
    if (!info) return null;
    const entry = vaultRegistry().find((e) => e.path === info.path);
    return entry?.display_name ?? info.name;
  });

  const [switcherMenu, setSwitcherMenu] = createSignal<{
    x: number;
    y: number;
  } | null>(null);

  function toggleSwitcher(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (switcherMenu()) {
      setSwitcherMenu(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const entries = vaultRegistry();
    const estimatedHeight = (entries.length + 1) * 32 + 12;
    const y = rect.top - estimatedHeight - 4;
    setSwitcherMenu({ x: rect.left, y: Math.max(4, y) });
    setTimeout(() => {
      const onDocClick = () => {
        setSwitcherMenu(null);
        document.removeEventListener("click", onDocClick);
      };
      document.addEventListener("click", onDocClick);
    }, 0);
  }

  async function switchToVault(path: string) {
    setSwitcherMenu(null);
    try {
      await openVault(path);
    } catch (err) {
      console.error("Failed to switch vault:", err);
    }
  }

  function openManageVaults() {
    setSwitcherMenu(null);
    document.dispatchEvent(
      new CustomEvent("inkycap:open-settings", { detail: { tab: "overview" } }),
    );
  }

  return (
    <div class="status-bar">
      <Show when={vaultInfo()} fallback={<span>No vault open</span>}>
        {(info) => (
          <>
            <button
              class="status-bar__vault-name"
              onClick={toggleSwitcher}
              title="Change vault"
            >
              {displayName()}
              <ArchiveRestore size={14} />
            </button>
            <span>{info().file_count} files</span>
            <span>{info().collection_count} collections</span>
          </>
        )}
      </Show>
      <div class="status-bar__spacer" />

      <Show when={isFileTab()}>
        <span class="status-bar__stat">
          {stats().words} words
        </span>
        <span class="status-bar__stat">
          {stats().chars} chars
        </span>
        <span class="status-bar__stat">
          ~{stats().readingTime} min read
        </span>
      </Show>

      <Show when={switcherMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{
              position: "fixed",
              left: `${menu().x}px`,
              top: `${menu().y}px`,
            }}
          >
            <For each={vaultRegistry()}>
              {(entry) => (
                <button
                  class="context-menu__item"
                  onClick={() => switchToVault(entry.path)}
                >
                  <span class="vault-switcher__name">{entry.display_name}</span>
                  <Show when={entry.path === vaultInfo()?.path}>
                    <Check size={14} class="context-menu__check" />
                  </Show>
                </button>
              )}
            </For>
            <div class="context-menu__separator" />
            <button class="context-menu__item" onClick={openManageVaults}>
              <Archive size={14} style={{ "margin-right": "6px", opacity: "0.6", "flex-shrink": "0" }} />
              Manage vaults...
            </button>
          </div>
        )}
      </Show>
    </div>
  );
};

export default StatusBar;

import { Component, For, Show } from "solid-js";
import {
  PanelLeftDashed,
  Sun,
  Moon,
  Settings,
  LayoutTemplate,
  Search,
  Handshake,
} from "lucide-solid";
import { theme, toggleTheme } from "../stores/theme";
import { leftCollapsed, toggleLeftCollapsed, setLeftCollapsed } from "../stores/layout";
import type { CreationRule } from "../lib/types";
import { openTab } from "../stores/tabs";
import { toolbarRules, triggerCreationRule } from "../stores/creation-rules";
import { collaborative, pendingCount } from "../stores/git";
import { t } from "../lib/i18n";
import RuleIcon from "./RuleIcon";
import { toastError } from "../stores/toasts";

export type SidebarMode =
  | "collections"
  | "agenda"
  | "filetree"
  | "tags"
  | "properties"
  | "search"
  | "bookmarks"
  | "templates"
  | "collaboration";

interface VerticalToolbarProps {
  mode: () => SidebarMode;
  setMode: (m: SidebarMode) => void;
  onOpenSettings?: () => void;
}

const VerticalToolbar: Component<VerticalToolbarProps> = (props) => {
  async function executeRule(rule: CreationRule) {
    try {
      const result = await triggerCreationRule(rule.id);
      if (!result) return;
      if (rule.creation_mode === "create_and_open") {
        const name = result.path.split("/").pop() ?? "New Note";
        openTab(
          { type: "file", title: name, path: result.path },
          { forceNewTab: true, cursorOffset: result.cursor_offset ?? undefined },
        );
      }
    } catch (e) {
      toastError(`Failed to execute creation rule "${rule.name ?? rule.id}"`, e);
    }
  }

  return (
    <div class="vertical-toolbar">
      {/* Header band: the sidebar show/hide toggle sits on the same row as
          the sidebar's mode-bar (matching height + bottom border below).
          Keeping it here also leaves it reachable when the sidebar is
          collapsed — it's the only way back. */}
      <div class="vertical-toolbar__header">
        <button
          class="vertical-toolbar__btn"
          onClick={toggleLeftCollapsed}
          title={leftCollapsed() ? "Show left sidebar" : "Hide left sidebar"}
          aria-label={leftCollapsed() ? "Show left sidebar" : "Hide left sidebar"}
        >
          <PanelLeftDashed size={18} />
        </button>
      </div>
      <div class="vertical-toolbar__body">
        <div class="vertical-toolbar__top">
          {/* Search leads the action buttons. The `__top` group starts at
              the sidebar's content level (see CSS), so this button lines up
              with the Search panel's input field that opens to its right. */}
          <button
            class={`vertical-toolbar__btn${props.mode() === "search" ? " vertical-toolbar__btn--active" : ""}`}
            onClick={() => {
              props.setMode("search");
              if (leftCollapsed()) setLeftCollapsed(false);
            }}
            title="Search (Ctrl+Shift+F)"
            aria-label="Search"
          >
            <Search size={18} />
          </button>

          <Show when={toolbarRules().length > 0}>
            <div class="vertical-toolbar__divider" />
            <For each={toolbarRules()}>
              {(rule) => (
                <button
                  class="vertical-toolbar__btn vertical-toolbar__creation-btn"
                  onClick={() => executeRule(rule)}
                  title={`${rule.name}${rule.hotkey ? ` (${rule.hotkey})` : ""}`}
                  aria-label={rule.name}
                >
                  <RuleIcon iconEmoji={rule.icon_emoji} name={rule.name} size={18} />
                </button>
              )}
            </For>
          </Show>
        </div>
        <div class="vertical-toolbar__bottom">
          {/* Collaboration entry point: only shown for a notebox that has git
              collaboration enabled (per the per-notebox opt-in in Settings).
              Sits just above the theme switcher. The badge mirrors the count
              of changed notes pending review. */}
          <Show when={collaborative()}>
            <button
              class={`vertical-toolbar__btn vertical-toolbar__collab-btn${props.mode() === "collaboration" ? " vertical-toolbar__btn--active" : ""}`}
              onClick={() => {
                props.setMode("collaboration");
                if (leftCollapsed()) setLeftCollapsed(false);
              }}
              title={t("git.toolbar.title")}
              aria-label={t("git.toolbar.title")}
            >
              <Handshake size={18} />
              <Show when={pendingCount() > 0}>
                <span class="vertical-toolbar__badge">{pendingCount()}</span>
              </Show>
            </button>
          </Show>
          <button
            class="vertical-toolbar__btn"
            onClick={toggleTheme}
            title={theme() === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle theme"
          >
            {theme() === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button
            class={`vertical-toolbar__btn${props.mode() === "templates" ? " vertical-toolbar__btn--active" : ""}`}
            onClick={() => {
              props.setMode("templates");
              if (leftCollapsed()) setLeftCollapsed(false);
            }}
            title="Scaffolds, Templates, &amp; Packages"
            aria-label="Open Scaffolds, Templates, &amp; Packages"
          >
            <LayoutTemplate size={18} />
          </button>
          <button
            class="vertical-toolbar__btn"
            onClick={() => props.onOpenSettings?.()}
            title="Settings (Ctrl+,)"
            aria-label="Settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default VerticalToolbar;

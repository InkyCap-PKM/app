import { Component, For, Show } from "solid-js";
import {
  PanelLeftDashed,
  Sun,
  Moon,
  Settings,
  LayoutTemplate,
  Search,
  CircleQuestionMark,
} from "lucide-solid";
import { theme, toggleTheme } from "../stores/theme";
import { leftCollapsed, toggleLeftCollapsed, setLeftCollapsed } from "../stores/layout";
import type { CreationRule } from "../lib/types";
import { openTab } from "../stores/tabs";
import { toolbarRules, triggerCreationRule } from "../stores/creation-rules";
import { useI18n } from "../lib/i18n";
import RuleIcon from "./RuleIcon";
import { toastError } from "../stores/toasts";
import { sidebarContributions } from "./sidebar-registry";
import { Dynamic } from "solid-js/web";

export type SidebarMode =
  | "collections"
  | "agenda"
  | "filetree"
  | "tags"
  | "properties"
  | "search"
  | "bookmarks"
  | "templates"
  | "collaboration"
  | "help"
  // A runtime-contributed mode id (plugin / manifest query-view). `(string & {})`
  // keeps autocomplete on the built-in literals while allowing any id.
  | (string & {});

interface VerticalToolbarProps {
  mode: () => SidebarMode;
  setMode: (m: SidebarMode) => void;
  onOpenSettings?: () => void;
  /** Toggle the Help panel: open it, or close it and restore the previous
   *  panel when it's already showing. Owned by App so it can remember the
   *  panel to return to. */
  onToggleHelp?: () => void;
}

const VerticalToolbar: Component<VerticalToolbarProps> = (props) => {
  const t = useI18n();
  async function executeRule(rule: CreationRule) {
    try {
      const result = await triggerCreationRule(rule.id);
      if (!result) return;
      if (rule.creation_mode === "create_and_open") {
        const name = result.path.split("/").pop() ?? t("verticalToolbar.newNoteFallback");
        openTab(
          { type: "file", title: name, path: result.path },
          { forceNewTab: true, cursorOffset: result.cursor_offset ?? undefined },
        );
      }
    } catch (e) {
      toastError(t("verticalToolbar.ruleFailed", { name: rule.name ?? rule.id }), e);
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
          title={leftCollapsed() ? t("verticalToolbar.showSidebar") : t("verticalToolbar.hideSidebar")}
          aria-label={leftCollapsed() ? t("verticalToolbar.showSidebar") : t("verticalToolbar.hideSidebar")}
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
            title={t("verticalToolbar.searchTitle")}
            aria-label={t("verticalToolbar.search")}
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

          {/* Contributed sidebar modes (plugins / manifest query-views).
              Renders nothing when the registry is empty, leaving the toolbar
              unchanged by default. */}
          <Show when={sidebarContributions().length > 0}>
            <div class="vertical-toolbar__divider" />
            <For each={sidebarContributions()}>
              {(c) => (
                <button
                  class={`vertical-toolbar__btn${props.mode() === c.id ? " vertical-toolbar__btn--active" : ""}`}
                  onClick={() => {
                    props.setMode(c.id);
                    if (leftCollapsed()) setLeftCollapsed(false);
                  }}
                  title={c.label}
                  aria-label={c.label}
                >
                  <Dynamic component={c.icon} size={18} />
                </button>
              )}
            </For>
          </Show>
        </div>
        <div class="vertical-toolbar__bottom">
          {/* Collaboration has no toolbar button: a collaborative notebox is
              reached from the status-bar chip (which also shows its state),
              the command palette, or Settings › Configure. */}
          <button
            class="vertical-toolbar__btn"
            onClick={toggleTheme}
            title={theme() === "dark" ? t("verticalToolbar.lightMode") : t("verticalToolbar.darkMode")}
            aria-label={t("verticalToolbar.toggleTheme")}
          >
            {theme() === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button
            class={`vertical-toolbar__btn${props.mode() === "templates" ? " vertical-toolbar__btn--active" : ""}`}
            onClick={() => {
              props.setMode("templates");
              if (leftCollapsed()) setLeftCollapsed(false);
            }}
            title={t("verticalToolbar.templatesTitle")}
            aria-label={t("verticalToolbar.templatesAria")}
          >
            <LayoutTemplate size={18} />
          </button>
          {/* Help sits just above Settings. Click toggles the Help panel
              open/closed (App owns the return-to-previous logic). */}
          <button
            class={`vertical-toolbar__btn${props.mode() === "help" ? " vertical-toolbar__btn--active" : ""}`}
            onClick={() => props.onToggleHelp?.()}
            title={t("verticalToolbar.helpTitle")}
            aria-label={t("verticalToolbar.help")}
          >
            <CircleQuestionMark size={18} />
          </button>
          <button
            class="vertical-toolbar__btn"
            onClick={() => props.onOpenSettings?.()}
            title={t("verticalToolbar.settingsTitle")}
            aria-label={t("verticalToolbar.settings")}
          >
            <Settings size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default VerticalToolbar;

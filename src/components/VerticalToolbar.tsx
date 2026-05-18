import { Component, For, Show } from "solid-js";
import {
  PanelLeftDashed,
  Sun,
  Moon,
  Settings,
  LayoutTemplate,
} from "lucide-solid";
import { theme, toggleTheme } from "../stores/theme";
import { leftCollapsed, toggleLeftCollapsed, setLeftCollapsed } from "../stores/layout";
import type { CreationRule } from "../lib/types";
import { openTab } from "../stores/tabs";
import { toolbarRules, triggerCreationRule } from "../stores/creation-rules";
import RuleIcon from "./RuleIcon";
import { toastError } from "../stores/toasts";

export type SidebarMode =
  | "collections"
  | "filetree"
  | "tags"
  | "properties"
  | "search"
  | "bookmarks"
  | "templates";

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
      <div class="vertical-toolbar__top">
        <button
          class="vertical-toolbar__btn"
          onClick={toggleLeftCollapsed}
          title={leftCollapsed() ? "Show left sidebar" : "Hide left sidebar"}
          aria-label={leftCollapsed() ? "Show left sidebar" : "Hide left sidebar"}
        >
          <PanelLeftDashed size={18} />
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
  );
};

export default VerticalToolbar;

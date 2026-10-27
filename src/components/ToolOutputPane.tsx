// Right-panel pane for an external tool's output (the "panel" output mode).
// Unlike the `notify` toast, it keeps the output in a tab so a multi-line
// result (a grammar or lint report) can be worked through while editing. Uses
// the right-panel registry.
//
// A tool pane belongs to the note it last ran on: it shows only while that note
// is active (the registry's `when`), so another note doesn't show a stale
// report. Its header has a close button that removes the tab.

import { Component, createSignal } from "solid-js";
import { Terminal, X } from "lucide-solid";
import { registerRightPanel } from "./right-panel-registry";
import { LUCIDE_ICON_MAP } from "./LucideIconPicker";
import { rightPanelTab, setRightPanelTab, setRightCollapsed } from "../stores/layout";
import { getActiveTab } from "../stores/tabs";
import { pathEquals } from "../lib/paths";
import { useI18n } from "../lib/i18n";

/**
 * A tool's pane state: the latest output and its note. Reactive, so running the
 * tool again updates the open pane and its note.
 */
interface ToolPaneState {
  name: string;
  text: string;
  /** The note the tool was last run against; the pane shows only on this note. */
  notePath: string | null;
}

const [panes, setPanes] = createSignal<Record<string, ToolPaneState>>({});
// Active disposers, so closing a pane unregisters its right-panel tab.
const disposers = new Map<string, () => void>();

const paneId = (toolId: string) => `tool-output:${toolId}`;

/** The active note's file path, or null when no file note is focused. */
function activeNotePath(): string | null {
  const tab = getActiveTab();
  return tab?.type === "file" ? tab.path : null;
}

/** Resolve a tool's `"lucide:<name>"` icon to a component, falling back to the
 *  default terminal glyph when unset or unknown. */
function resolveIcon(icon: string | undefined): Component<{ size?: number }> {
  if (icon && icon.startsWith("lucide:")) {
    const comp = LUCIDE_ICON_MAP[icon.slice("lucide:".length)];
    if (comp) return comp;
  }
  return Terminal;
}

const ToolOutputPane: Component<{ toolId: string }> = (props) => {
  const t = useI18n();
  return (
    <div class="right-panel__pane">
      <div class="right-panel__section-header">
        <span>{panes()[props.toolId]?.name ?? ""}</span>
        <div class="right-panel__header-actions">
          <button
            class="ui-icon-btn"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={() => closeToolOutputPane(props.toolId)}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <pre class="tool-output__text">{panes()[props.toolId]?.text ?? ""}</pre>
    </div>
  );
};

/**
 * Show a tool's output in a right-panel pane for `notePath`: register (or
 * update) a tab for the tool with its icon, and focus it (expanding the panel
 * if collapsed).
 */
export function showToolOutputPane(
  toolId: string,
  toolName: string,
  text: string,
  notePath: string | null,
  icon?: string,
): void {
  setPanes((prev) => ({ ...prev, [toolId]: { name: toolName, text, notePath } }));
  // (Re-)register so the label and icon stay current; replacing by id is cheap
  // and the `when` gate reads `panes()` live, so it tracks the latest note.
  const Icon = resolveIcon(icon);
  const dispose = registerRightPanel({
    id: paneId(toolId),
    label: toolName,
    icon: Icon,
    component: () => <ToolOutputPane toolId={toolId} />,
    // Show only while the note the tool was run against is the active one.
    when: () => {
      const owner = panes()[toolId]?.notePath ?? null;
      return owner != null && pathEquals(activeNotePath(), owner);
    },
  });
  disposers.set(toolId, dispose);
  setRightCollapsed(false);
  setRightPanelTab(paneId(toolId));
}

/**
 * Close a tool's output pane: remove its tab and state. If it was the active
 * tab, switch to a built-in one so the panel isn't blank.
 */
export function closeToolOutputPane(toolId: string): void {
  disposers.get(toolId)?.();
  disposers.delete(toolId);
  setPanes((prev) => {
    const next = { ...prev };
    delete next[toolId];
    return next;
  });
  if (rightPanelTab() === paneId(toolId)) setRightPanelTab("outline");
}

export default ToolOutputPane;

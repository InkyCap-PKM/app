// Right-panel pane for an external tool's output — the "panel" output
// disposition of the external-tool bridge, and the in-tree consumer of the
// right-panel registry. Unlike the transient `notify` toast, this keeps a
// tool's stdout visible in a note-context tab so the user can work through a
// multi-line result (a grammar/lint report, say) while editing.

import { Component, createSignal } from "solid-js";
import { Terminal } from "lucide-solid";
import { registerRightPanel } from "./right-panel-registry";
import { setRightPanelTab, setRightCollapsed } from "../stores/layout";

// Latest stdout per tool id — reactive so re-running a tool refreshes the open
// pane in place rather than spawning a new tab.
const [outputs, setOutputs] = createSignal<Record<string, string>>({});
// Tool ids that already have a registered right-panel tab, so re-runs reuse it.
const registered = new Set<string>();

const paneId = (toolId: string) => `tool-output:${toolId}`;

const ToolOutputPane: Component<{ toolId: string }> = (props) => (
  <div class="right-panel__tab-content">
    <pre class="tool-output__text">{outputs()[props.toolId] ?? ""}</pre>
  </div>
);

/** Show an external tool's stdout in a persistent right-panel pane. Registers a
 *  tab the first time a given tool produces panel output, reuses it after, and
 *  focuses it (expanding the panel if collapsed). */
export function showToolOutputPane(toolId: string, toolName: string, text: string): void {
  setOutputs((prev) => ({ ...prev, [toolId]: text }));
  if (!registered.has(toolId)) {
    registered.add(toolId);
    registerRightPanel({
      id: paneId(toolId),
      label: toolName,
      icon: Terminal,
      component: () => <ToolOutputPane toolId={toolId} />,
    });
  }
  setRightCollapsed(false);
  setRightPanelTab(paneId(toolId));
}

export default ToolOutputPane;

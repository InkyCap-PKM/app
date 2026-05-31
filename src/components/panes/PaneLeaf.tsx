import { Component, Show } from "solid-js";
import { tabs, setTabDirty, type Tab } from "../../stores/tabs";
import { focusPane, focusedPaneId, type LeafPane } from "../../stores/panes";
import { useI18n } from "../../lib/i18n";
import { modifierKey } from "../../lib/platform";
import CollectionTable from "../CollectionTable";
import TypstEditor from "../TypstEditor";
import MycelialView from "../MycelialView";
import TabStrip from "./TabStrip";

/// Tabula-rasa view shown when a pane's active tab is the `empty`
/// placeholder (or it has no tab). The modifier glyph adapts to the host OS.
const EmptyState: Component = () => {
  const t = useI18n();
  const modifier = modifierKey();
  return (
    <div class="empty-state">
      <p class="empty-state__primary">{t("mainContent.emptyState")}</p>
      <p>{" "}</p>
      <p class="empty-state__hint">{t("mainContent.emptyState.shortcuts")}</p>
      <p class="empty-state__hint">{t("mainContent.emptyState.openFileHint", { modifier })}</p>
      <p class="empty-state__hint">{t("mainContent.emptyState.createFileHint", { modifier })}</p>
      <p class="empty-state__hint">{t("mainContent.emptyState.commandsHint", { modifier })}</p>
    </div>
  );
};

/**
 * One leaf pane: its tab strip over the content of its active tab. The
 * content is keyed by `${tabId}::${type}::${path}` so the editor rebuilds
 * when a tab navigates in place — and, crucially, two tabs sharing a path
 * (the same note open in two panes, or as a Journal Scroll anchor) get
 * distinct editor instances rather than being conflated.
 */
const PaneLeaf: Component<{ leaf: LeafPane }> = (props) => {
  const activeTab = (): Tab | undefined =>
    props.leaf.activeTabId
      ? tabs.find((tab) => tab.id === props.leaf.activeTabId)
      : undefined;

  const isFocused = () => focusedPaneId() === props.leaf.id;

  return (
    <div
      class={`pane pane--leaf${isFocused() ? " pane--focused" : ""}`}
      onPointerDown={() => focusPane(props.leaf.id)}
      onFocusIn={() => focusPane(props.leaf.id)}
    >
      <TabStrip leaf={props.leaf} />
      <div
        class={`main-content__body${activeTab()?.type === "collection" ? " main-content__body--collection" : ""}`}
      >
        <Show when={activeTab()} fallback={<EmptyState />}>
          {(tab) => (
            <Show when={`${tab().id}::${tab().type}::${tab().path}`} keyed>
              {(_key: string) => {
                const currentTab = tab();
                if (currentTab.type === "empty" || !currentTab.path) {
                  return <EmptyState />;
                }
                if (currentTab.type === "collection") {
                  return <CollectionTable path={currentTab.path} />;
                }
                if (currentTab.type === "mycelial") {
                  return <MycelialView path={currentTab.path} />;
                }
                return (
                  <TypstEditor
                    path={currentTab.path}
                    tabId={currentTab.id}
                    onDirtyChange={(dirty) => setTabDirty(currentTab.id, dirty)}
                  />
                );
              }}
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
};

export default PaneLeaf;

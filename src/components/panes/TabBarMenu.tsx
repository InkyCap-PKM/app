import { Component, For, Show, createSignal, onCleanup } from "solid-js";
import {
  tabs,
  setActiveTabId,
  splitPane,
  closePane,
  tabDisplayTitle,
} from "../../stores/tabs";
import { hasMultiplePanes, type LeafPane } from "../../stores/panes";
import { t } from "../../lib/i18n";
import { MenuTabsIcon } from "../icons";
import {
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
  Check,
} from "lucide-solid";

/**
 * The pane menu at the right edge of a tab strip (`MenuTabsIcon` glyph).
 * Offers split/close-pane actions for this pane, plus a list of every open
 * tab (grouped by pane when more than one exists) as a second way to switch.
 */
const TabBarMenu: Component<{ leaf: LeafPane }> = (props) => {
  const [open, setOpen] = createSignal(false);
  let wrapRef: HTMLDivElement | undefined;

  function onDocPointerDown(e: PointerEvent) {
    if (wrapRef && !wrapRef.contains(e.target as Node)) setOpen(false);
  }
  // Listener is attached only while the menu is open (see toggle()).
  onCleanup(() => document.removeEventListener("pointerdown", onDocPointerDown));

  function toggle() {
    const next = !open();
    setOpen(next);
    if (next) document.addEventListener("pointerdown", onDocPointerDown);
    else document.removeEventListener("pointerdown", onDocPointerDown);
  }

  function close() {
    setOpen(false);
    document.removeEventListener("pointerdown", onDocPointerDown);
  }

  return (
    <div class="tab-bar__menu" ref={wrapRef}>
      <button
        class="tab-bar__menu-btn"
        title={t("pane.menu.title")}
        aria-label={t("pane.menu.title")}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={toggle}
      >
        <MenuTabsIcon size={18} />
      </button>
      <Show when={open()}>
        <div class="tab-bar__menu-popup" role="menu">
          <button
            class="tab-bar__menu-item"
            role="menuitem"
            onClick={() => {
              splitPane(props.leaf.id, "row");
              close();
            }}
          >
            <SplitSquareHorizontal size={15} />
            <span>{t("pane.splitRight")}</span>
          </button>
          <button
            class="tab-bar__menu-item"
            role="menuitem"
            onClick={() => {
              splitPane(props.leaf.id, "column");
              close();
            }}
          >
            <SplitSquareVertical size={15} />
            <span>{t("pane.splitDown")}</span>
          </button>
          <Show when={hasMultiplePanes()}>
            <button
              class="tab-bar__menu-item"
              role="menuitem"
              onClick={() => {
                closePane(props.leaf.id);
                close();
              }}
            >
              <X size={15} />
              <span>{t("pane.close")}</span>
            </button>
          </Show>

          <div class="tab-bar__menu-divider" />

          <For each={props.leaf.tabIds}>
            {(tabId) => {
              const tab = () => tabs.find((x) => x.id === tabId);
              return (
                <Show when={tab()}>
                  {(resolved) => (
                    <button
                      class="tab-bar__menu-item tab-bar__menu-item--tab"
                      role="menuitemradio"
                      aria-checked={tabId === props.leaf.activeTabId}
                      onClick={() => {
                        setActiveTabId(tabId);
                        close();
                      }}
                    >
                      <span class="tab-bar__menu-check">
                        <Show when={tabId === props.leaf.activeTabId}>
                          <Check size={14} />
                        </Show>
                      </span>
                      <span class="tab-bar__menu-tab-title">
                        {tabDisplayTitle(resolved())}
                      </span>
                    </button>
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default TabBarMenu;

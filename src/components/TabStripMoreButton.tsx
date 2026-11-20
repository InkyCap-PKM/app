// The "more" button at the end of a panel's tab row (the left sidebar's mode
// bar, the right panel's tabs). It shows only while some tabs don't fit, and
// opens a menu listing those tabs by icon and name; choosing one clicks the
// tab itself, so the menu needs no knowledge of what each tab does.

import { Component, For, Show, createSignal } from "solid-js";
import { ChevronsRight } from "lucide-solid";
import type { TabStripOverflowState } from "../lib/overflow";
import { anchorPanelMenu } from "../lib/uiMenu";
import { clickOutside } from "../lib/clickOutside";
import { useI18n } from "../lib/i18n";

void clickOutside; // used as the `use:clickOutside` directive below

interface HiddenTab {
  button: HTMLButtonElement;
  label: string;
  icon: SVGElement | null;
  active: boolean;
}

const TabStripMoreButton: Component<{
  overflow: TabStripOverflowState;
}> = (props) => {
  const t = useI18n();
  const [hidden, setHidden] = createSignal<HiddenTab[] | null>(null);
  let btn: HTMLButtonElement | undefined;

  // Read the hidden tabs when the menu opens, so the list matches what the
  // row shows at that moment.
  const open = () => {
    setHidden(
      props.overflow.hiddenButtons().map((b) => {
        const svg = b.querySelector("svg");
        const icon = svg ? (svg.cloneNode(true) as SVGElement) : null;
        icon?.setAttribute("width", "16");
        icon?.setAttribute("height", "16");
        icon?.setAttribute("aria-hidden", "true");
        return {
          button: b,
          label: b.getAttribute("aria-label") ?? b.title,
          icon,
          active: b.classList.contains(props.overflow.activeClass),
        };
      }),
    );
  };
  const close = () => setHidden(null);

  return (
    <Show when={props.overflow.overflowing()}>
      <button
        ref={btn}
        class="panel-tab-more"
        classList={{ "panel-tab-more--active": props.overflow.activeHidden() }}
        data-tab-overflow
        aria-haspopup="menu"
        aria-expanded={hidden() !== null}
        title={t("panelTabs.more")}
        aria-label={t("panelTabs.more")}
        onClick={() => (hidden() ? close() : open())}
      >
        <ChevronsRight size={14} />
      </button>
      <Show when={hidden()}>
        {(tabs) => (
          <div
            class="context-menu"
            role="menu"
            ref={(el) => anchorPanelMenu(btn, el)}
            use:clickOutside={{ onDismiss: close, ignore: btn }}
          >
            <For each={tabs()}>
              {(tab) => (
                <button
                  class="context-menu__item context-menu__item--icon"
                  classList={{ "context-menu__item--active": tab.active }}
                  role="menuitem"
                  onClick={() => {
                    close();
                    tab.button.click();
                  }}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
    </Show>
  );
};

export default TabStripMoreButton;

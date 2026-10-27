// Keyboard navigation for simple list panels (outline, bookmarks, references,
// annotations, tags, templates, agenda, …).
//
// Rows are clickable `<div>`s, not focusable, so this works like the file tree:
// the container is the one Tab stop, ↑/↓/Home/End move a cursor (the
// `.is-kbd-active` row, announced with aria-activedescendant), and Enter/Space
// clicks the active row, so rows keep their onClick.
//
// Usage:
//   <div class="…" ref={attachListNav}> … rows with data-list-item … </div>
// Mark each navigable row with `data-list-item`.

let idCounter = 0;

/**
 * Add keyboard navigation to a list container. Safe to pass straight as a Solid
 * `ref`. The listeners are on the element, so they go when it unmounts.
 */
export function attachListNav(container: HTMLElement): void {
  if (container.dataset.listNav === "on") return; // already wired
  container.dataset.listNav = "on";
  if (container.tabIndex < 0) container.tabIndex = 0;
  if (!container.getAttribute("role")) container.setAttribute("role", "listbox");
  // Let F6 region-cycling land directly on the list.
  if (!container.hasAttribute("data-focus-entry")) container.setAttribute("data-focus-entry", "");

  const items = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>("[data-list-item]")).filter(
      (el) => el.getClientRects().length > 0,
    );

  const activeOf = (list: HTMLElement[]): HTMLElement | null =>
    list.find((el) => el.classList.contains("is-kbd-active")) ?? null;

  const setActive = (el: HTMLElement | null, list: HTMLElement[]) => {
    for (const it of list) it.classList.toggle("is-kbd-active", it === el);
    if (el) {
      if (!el.id) el.id = `lnav-${++idCounter}`;
      container.setAttribute("aria-activedescendant", el.id);
      el.scrollIntoView({ block: "nearest" });
    } else {
      container.removeAttribute("aria-activedescendant");
    }
  };

  container.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return; // a row's own field owns its keys
    const list = items();
    if (list.length === 0) return;
    const idx = list.indexOf(activeOf(list) as HTMLElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive(list[idx < 0 ? 0 : Math.min(idx + 1, list.length - 1)], list);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive(list[idx < 0 ? 0 : Math.max(idx - 1, 0)], list);
        break;
      case "Home":
        e.preventDefault();
        setActive(list[0], list);
        break;
      case "End":
        e.preventDefault();
        setActive(list[list.length - 1], list);
        break;
      case "Enter":
      case " ": {
        const el = activeOf(list);
        if (el) {
          e.preventDefault();
          el.click();
        }
        break;
      }
    }
  });

  // First focus (Tab or F6) seeds the cursor on the current/selected row if the
  // panel marks one, else the first row.
  container.addEventListener("focus", () => {
    const list = items();
    if (list.length === 0 || activeOf(list)) return;
    const preferred =
      list.find((el) =>
        el.matches('[data-list-active], .is-active, [aria-selected="true"], [aria-current="true"]'),
      ) ?? list[0];
    setActive(preferred, list);
  });
}

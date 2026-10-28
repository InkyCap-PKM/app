// Right-sidebar reference for the Typst packages a note uses: each function the
// package offers, what it does and the options it takes, as the bundled
// Tinymist reads them from the package. Lists the note's own imports, plus a
// package chosen for the note (from the Templates panel or Properties pane).

import { Component, For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js";
import * as ipc from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/errors";
import { activeNotePath } from "../stores/tabs";
import { chosenPackageFor, packageSpecOfFile } from "../stores/package-reference";
import { Dropdown } from "./Dropdown";
import RowChevron from "./RowChevron";
import LoadingDots from "./LoadingDots";
import Notice from "./Notice";

const PackageReferencePanel: Component<{
  /** The packages the open note imports. */
  imports: readonly string[];
}> = (props) => {
  const t = useI18n();

  // The package the open file belongs to (its typst.toml, its starter file)
  // comes first, then one chosen for this note, then the note's imports.
  const specs = createMemo(() => {
    const list = [...props.imports];
    const path = activeNotePath();
    for (const spec of [chosenPackageFor(path), path ? packageSpecOfFile(path) : null]) {
      if (spec && !list.includes(spec)) list.unshift(spec);
    }
    return list;
  });

  const [selected, setSelected] = createSignal<string | null>(null);
  // Follow a package opened from the Templates panel, and fall back to the
  // first available one when the selection is no longer in the list.
  createEffect(() => {
    const chosen = chosenPackageFor(activeNotePath());
    if (chosen) setSelected(chosen);
  });
  createEffect(() => {
    const path = activeNotePath();
    const own = path ? packageSpecOfFile(path) : null;
    if (own) setSelected(own);
  });
  const current = createMemo(() => {
    const list = specs();
    const sel = selected();
    return sel && list.includes(sel) ? sel : (list[0] ?? null);
  });

  const [docs] = createResource(current, (spec) => ipc.getPackageDocs(spec));
  // Reading a failed resource throws its error, so go through this instead.
  const loadedDocs = () => (docs.error ? undefined : docs());

  const [filter, setFilter] = createSignal("");
  const symbols = createMemo(() => {
    const q = filter().trim().toLowerCase();
    const all = loadedDocs()?.symbols ?? [];
    return q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all;
  });

  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  function toggle(name: string) {
    const next = new Set(expanded());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpanded(next);
  }

  function kindLabel(kind: ipc.PackageDocSymbol["kind"]): string {
    switch (kind) {
      case "function":
        return t("packageReference.kind.function");
      case "module":
        return t("packageReference.kind.module");
      default:
        return t("packageReference.kind.value");
    }
  }

  function paramName(p: ipc.PackageDocParam): string {
    return p.kind === "rest" ? `..${p.name}` : p.name;
  }

  return (
    <div class="right-panel__pane package-reference">
      <Show
        when={specs().length > 0}
        fallback={<p class="sidebar-hint">{t("packageReference.empty")}</p>}
      >
        <div class="package-reference__controls">
          <Dropdown<string>
            class="dropdown--block"
            value={current() ?? ""}
            options={specs().map((s) => ({ value: s, label: s }))}
            onChange={(v) => setSelected(v)}
            ariaLabel={t("packageReference.package")}
          />
          <input
            type="text"
            class="settings__text-input"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            placeholder={t("packageReference.filter")}
            aria-label={t("packageReference.filter")}
          />
        </div>
        <Show when={loadedDocs()?.is_template}>
          <Notice class="package-reference__notice">{t("templates.details.pdfOnly")}</Notice>
        </Show>
        <Show when={docs.loading}>
          <p class="sidebar-hint">
            {t("packageReference.loading")} <LoadingDots />
          </p>
        </Show>
        <Show when={docs.error}>
          <p class="sidebar-hint sidebar-hint--error">
            {t("packageReference.loadFailed")} {errorText(docs.error)}
          </p>
        </Show>
        <Show when={!docs.loading && loadedDocs() && symbols().length === 0}>
          <p class="sidebar-hint">{t("packageReference.noSymbols")}</p>
        </Show>
        <div class="package-reference__list">
          <For each={docs.loading ? [] : symbols()}>
            {(symbol) => {
              const open = () => expanded().has(symbol.name);
              const summary = () => symbol.docs?.split("\n\n")[0] ?? null;
              return (
                <div class="package-reference__symbol">
                  <div class="sidebar-item" onClick={() => toggle(symbol.name)}>
                    <RowChevron expanded={open()} onToggle={() => toggle(symbol.name)} />
                    <code class="sidebar-item__label">{symbol.name}</code>
                    <span class="badge">{kindLabel(symbol.kind)}</span>
                  </div>
                  <Show when={!open() && summary()}>
                    <p class="package-reference__summary" onClick={() => toggle(symbol.name)}>
                      {summary()}
                    </p>
                  </Show>
                  <Show when={open()}>
                    <div class="package-reference__detail">
                      <Show when={symbol.docs}>
                        <p class="package-reference__docs">{symbol.docs}</p>
                      </Show>
                      <Show when={symbol.params.length > 0}>
                        <ul class="package-reference__params">
                          <For each={symbol.params}>
                            {(p) => (
                              <li>
                                <code>{paramName(p)}</code>
                                <Show when={p.ty}>
                                  <span class="package-reference__type">{p.ty}</span>
                                </Show>
                                <Show when={p.default}>
                                  <span class="package-reference__default">
                                    {t("packageReference.default", { value: p.default ?? "" })}
                                  </span>
                                </Show>
                                <Show when={p.docs}>
                                  <p class="package-reference__param-docs">{p.docs}</p>
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default PackageReferencePanel;

// The Packages section of the Properties pane: the Typst packages the note
// imports, with ways to add one, remove one, or open its reference. Imports
// are hidden in the visual editor and InkyCap writes a package's import above
// its own, where the user can't type, so this is how they're managed.

import { Component, For, Show, createMemo, createResource } from "solid-js";
import { PackageSearch, X } from "lucide-solid";
import * as ipc from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { addPackageToNote, removePackageFromNote } from "../lib/note-packages";
import { showPackageReference } from "../stores/package-reference";
import { noteboxInfo } from "../stores/notebox";
import { promptConfirm } from "../stores/prompt";
import { toastError } from "../stores/toasts";
import { Dropdown } from "./Dropdown";

const NotePackagesSection: Component<{
  path: string;
  /** The packages the note imports. */
  imports: readonly string[];
}> = (props) => {
  const t = useI18n();

  const [installed] = createResource(
    () => noteboxInfo(),
    () => ipc.listInstalledPackages().catch(() => [] as ipc.InstalledPackageEntry[]),
  );
  const addable = createMemo(() => {
    const already = new Set(props.imports);
    // Templates first, so each kind sits under one group heading.
    return (installed() ?? [])
      .filter((p) => !already.has(p.spec))
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "template" ? -1 : 1));
  });

  async function add(spec: string) {
    if (!spec) return;
    try {
      await addPackageToNote(props.path, spec);
    } catch (err) {
      toastError(t("notePackages.addFailed"), err);
    }
  }

  async function remove(spec: string) {
    const ok = await promptConfirm({
      title: t("notePackages.removeTitle", { spec }),
      message: t("notePackages.removeMessage", { spec }),
      confirmLabel: t("common.remove"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    try {
      await removePackageFromNote(props.path, spec);
    } catch (err) {
      toastError(t("notePackages.removeFailed"), err);
    }
  }

  return (
    <div class="note-packages">
      <Show
        when={props.imports.length > 0}
        fallback={<p class="sidebar-hint">{t("notePackages.none")}</p>}
      >
        <For each={props.imports}>
          {(spec) => (
            <div class="sidebar-item note-packages__item">
              <button
                class="note-packages__name"
                onClick={() => showPackageReference(spec)}
                title={t("notePackages.openReference", { spec })}
              >
                <PackageSearch size={12} />
                <span class="sidebar-item__label">{spec}</span>
              </button>
              <button
                class="ui-icon-btn"
                onClick={() => void remove(spec)}
                title={t("notePackages.remove", { spec })}
                aria-label={t("notePackages.remove", { spec })}
              >
                <X size={13} />
              </button>
            </div>
          )}
        </For>
      </Show>
      <Show when={addable().length > 0}>
        <Dropdown<string>
          class="dropdown--block"
          value=""
          placeholder={t("notePackages.add")}
          options={addable().map((p) => ({
            value: p.spec,
            label: p.spec,
            group:
              p.kind === "template"
                ? t("templates.title.templates")
                : t("templates.title.packages"),
          }))}
          onChange={(spec) => void add(spec)}
          ariaLabel={t("notePackages.add")}
        />
      </Show>
    </div>
  );
};

export default NotePackagesSection;

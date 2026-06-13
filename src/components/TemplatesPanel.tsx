// Scaffolds / Document Templates / Packages — rendered as an inline pane
// in the left sidebar (LeftSidebar mode = "templates"). Entry point is the
// LayoutTemplate button on the vertical toolbar, which sets the sidebar
// mode (it does not open a modal).
//
// What lives where:
//   .inkycap/scaffolds/             — user-authored note-body scaffolds
//   .inkycap/packages/<ns>/<n>/<v>/ — Typst packages (templates + libs)
//
// The Typst compiler requires the `<namespace>/<name>/<version>/` layout
// to resolve `@preview/name:version` imports. The `@preview` namespace is
// the Typst Universe public registry; `@local/` is user-authored content.

import { Component, For, Show, createResource, createSignal } from "solid-js";
import { attachListNav } from "../lib/list-nav";
import {
  Pyramid,
  Layers2,
  Box,
  Plus,
  RefreshCw,
  Download,
  FolderInput,
  Trash2,
  Info,
} from "lucide-solid";
import * as ipc from "../lib/ipc";
import { openTab } from "../stores/tabs";
import { promptText, promptConfirm } from "../stores/prompt";
import { toastError, showToast } from "../stores/toasts";
import { useI18n } from "../lib/i18n";
import { linkifyTerm } from "./ExternalLink";
import { noteboxInfo } from "../stores/notebox";

type SubTab = "scaffolds" | "templates" | "packages";

// The Typst Universe registry, deep-linked to the kind shown in each tab.
const UNIVERSE_TEMPLATES_URL = "https://typst.app/universe/search/?kind=templates";
const UNIVERSE_PACKAGES_URL = "https://typst.app/universe/search/?kind=packages";

const TemplatesPanel: Component = () => {
  const t = useI18n();
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [tab, setTab] = createSignal<SubTab>("scaffolds");
  const [showHelp, setShowHelp] = createSignal(false);

  // Keyed on noteboxInfo() too: scaffolds/templates/packages are notebox-scoped,
  // so opening or switching noteboxes must refetch — mirrors the file-tree and
  // collection resources in LeftSidebar.
  const [scaffolds] = createResource(
    () => ({ info: noteboxInfo(), key: refreshKey() }),
    async () => ipc.listScaffoldEntries(),
  );
  const [packages] = createResource(
    () => ({ info: noteboxInfo(), key: refreshKey() }),
    async () => ipc.listInstalledPackages(),
  );

  function refresh() {
    setRefreshKey((k) => k + 1);
  }

  function templatePackages(): ipc.InstalledPackageEntry[] {
    return (packages() ?? []).filter((p) => p.kind === "template");
  }

  function libraryPackages(): ipc.InstalledPackageEntry[] {
    return (packages() ?? []).filter((p) => p.kind === "library");
  }

  function openScaffold(entry: ipc.TemplateEntry) {
    openTab(
      { type: "file", title: `${entry.name}.typ`, path: entry.path },
      { forceNewTab: false },
    );
  }

  function openPackageManifest(pkg: ipc.InstalledPackageEntry) {
    const toml = `${pkg.install_dir}/typst.toml`;
    openTab(
      { type: "file", title: `${pkg.name}/typst.toml`, path: toml },
      { forceNewTab: false },
    );
  }

  async function newScaffold() {
    const name = await promptText({
      title: t("templates.prompt.newScaffold.title"),
      label: t("templates.prompt.newScaffold.label"),
      placeholder: "daily-note",
      hint: t("templates.prompt.newScaffold.hint"),
      confirmLabel: t("common.create"),
    });
    if (!name) return;
    try {
      const path = await ipc.createScaffold(name);
      refresh();
      openTab(
        { type: "file", title: `${name}.typ`, path },
        { forceNewTab: false },
      );
    } catch (e) {
      toastError(t("templates.createScaffoldFailed"), e);
    }
  }

  async function installBySpec() {
    const spec = await promptText({
      title: t("templates.prompt.installSpec.title"),
      label: t("templates.prompt.installSpec.label"),
      placeholder: "@preview/cetz:0.2.0",
      hint: t("templates.prompt.installSpec.hint"),
      confirmLabel: t("templates.install"),
    });
    if (!spec) return;
    try {
      const result = await ipc.installTypstPackageBySpec(spec);
      showToast(
        "success",
        t("templates.installed", { spec: result.spec, files: result.files_written }),
      );
      refresh();
    } catch (e) {
      toastError(t("templates.installFailed"), e);
    }
  }

  async function installFromFile() {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const { homeDirDefault } = await import("../lib/dialog-defaults");
    // This dialog only chooses which tarball on disk to read; the install
    // destination is fixed by the backend (the notebox's package dir). The
    // source archive lives on the user's computer, so default to home.
    const path = await openDialog({
      title: t("templates.prompt.installFromFile.title"),
      defaultPath: await homeDirDefault(),
      // Tauri filter extensions match the final dot-segment only — `tar.gz`
      // wouldn't match. List `gz`+`tgz`; backend validates actual shape.
      filters: [{ name: t("templates.prompt.tarball"), extensions: ["gz", "tgz"] }],
    });
    if (!path) return;
    try {
      const result = await ipc.installTypstPackageFromFile(path as string);
      showToast(
        "success",
        t("templates.installed", { spec: result.spec, files: result.files_written }),
      );
      refresh();
    } catch (e) {
      toastError(t("templates.installFailed"), e);
    }
  }

  async function newLocalPackage(asTemplate: boolean) {
    const placeholder = asTemplate ? "letter-layout" : "my-utils";
    const spec = await promptText({
      title: asTemplate ? t("templates.prompt.newLocalTemplate.title") : t("templates.prompt.newLocalPackage.title"),
      label: t("templates.prompt.newLocal.label"),
      placeholder,
      hint: t("templates.prompt.newLocal.hint", { placeholder }),
      confirmLabel: t("common.create"),
    });
    if (!spec) return;
    try {
      const result = await ipc.createLocalPackage(spec, asTemplate);
      showToast("success", `Created ${result.spec}`);
      refresh();
      const filename = result.entrypoint_path.split(/[\\/]/).pop() ?? "lib.typ";
      openTab(
        { type: "file", title: filename, path: result.entrypoint_path },
        { forceNewTab: false },
      );
    } catch (e) {
      toastError(
        asTemplate ? t("templates.createTemplateFailed") : t("templates.createPackageFailed"),
        e,
      );
    }
  }

  function namespaceLabel(
    namespace: string,
    kind: "template" | "library",
  ): string {
    if (namespace === "preview") return t("templates.ns.universe");
    if (namespace === "local") {
      return kind === "template" ? t("templates.ns.yourTemplate") : t("templates.ns.yourPackage");
    }
    return `@${namespace}`;
  }

  // A heading + bulleted list, with an "…and N more" tail when `total`
  // exceeds the shown items. `promptConfirm` renders message newlines verbatim
  // (white-space: pre-wrap), so this composes directly into the confirm body.
  function depsBlock(heading: string, items: string[], total: number): string {
    const lines = items.map((i) => `• ${i}`);
    if (total > items.length) {
      lines.push(t("templates.deps.andMore", { count: total - items.length }));
    }
    return `${heading}\n${lines.join("\n")}`;
  }

  async function deleteScaffold(entry: ipc.TemplateEntry) {
    // Defense-in-depth: the button is hidden for system scaffolds, and the
    // backend refuses them too.
    if (entry.builtin) return;

    // The only thing that depends on a scaffold is a creation rule's
    // scaffold_path (notes don't, post-creation). The list is always short, so
    // it's shown in full. A missing scaffold degrades a rule gracefully, hence
    // warn-and-allow rather than block.
    let dependentRules: string[] = [];
    try {
      const rules = await ipc.listCreationRules();
      dependentRules = rules
        .filter((r) => r.scaffold_path.replace(/\.typ$/, "") === entry.name)
        .map((r) => r.name);
    } catch {
      // If rules can't be loaded, fall through to a plain confirm.
    }

    let message = t("templates.deleteScaffoldConfirm", { name: entry.name });
    if (dependentRules.length > 0) {
      message +=
        "\n\n" +
        depsBlock(
          t("templates.deleteScaffoldRulesHeading"),
          dependentRules,
          dependentRules.length,
        ) +
        "\n\n" +
        t("templates.deleteScaffoldRulesNote");
    }

    const ok = await promptConfirm({
      title: t("templates.deleteScaffoldTitle"),
      message,
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    try {
      await ipc.deleteScaffold(entry.name);
      showToast("success", t("templates.scaffoldDeleted", { name: entry.name }));
      refresh();
    } catch (e) {
      toastError(t("templates.scaffoldDeleteFailed"), e);
    }
  }

  async function uninstall(pkg: ipc.InstalledPackageEntry) {
    // Warn-and-allow: surface what imports this exact version, but never block.
    let message = t("templates.uninstallConfirm", { spec: pkg.spec });
    try {
      const deps = await ipc.findPackageDependents(pkg.spec);
      if (deps.rules.length > 0) {
        message +=
          "\n\n" +
          depsBlock(
            t("templates.uninstallRulesHeading"),
            deps.rules,
            deps.rules.length,
          );
      }
      if (deps.note_total > 0) {
        message +=
          "\n\n" +
          depsBlock(
            t("templates.uninstallNotesHeading"),
            deps.notes,
            deps.note_total,
          ) +
          "\n\n" +
          t("templates.uninstallNotesNote");
      }
    } catch {
      // If the scan fails, fall back to the plain confirm message.
    }

    const ok = await promptConfirm({
      title: t("templates.uninstallTitle", { spec: pkg.spec }),
      message,
      confirmLabel: t("common.uninstall"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    try {
      await ipc.uninstallTypstPackage(pkg.spec);
      showToast("success", t("templates.uninstalled", { spec: pkg.spec }));
      refresh();
    } catch (e) {
      toastError(t("templates.uninstallFailed"), e);
    }
  }

  function copyImport(text: string) {
    navigator.clipboard.writeText(text).then(
      () => showToast("info", t("templates.importCopied")),
      (err) => toastError(t("templates.copyFailed"), err),
    );
  }

  function packageImportLine(pkg: ipc.InstalledPackageEntry): string {
    return `#import "${pkg.spec}": *`;
  }

  function title(): string {
    switch (tab()) {
      case "scaffolds":
        return t("templates.title.scaffolds");
      case "templates":
        return t("templates.title.templates");
      case "packages":
        return t("templates.title.packages");
    }
  }

  return (
    <>
      <div class="left-sidebar__section-header templates-pane__header">
        <span class="templates-pane__title">{title()}</span>
        <div class="templates-pane__tabs" role="tablist">
          <button
            class={`left-sidebar__icon-btn${tab() === "scaffolds" ? " left-sidebar__icon-btn--active" : ""}`}
            onClick={() => setTab("scaffolds")}
            role="tab"
            aria-selected={tab() === "scaffolds"}
            title={t("templates.title.scaffolds")}
            aria-label={t("templates.title.scaffolds")}
          >
            <Pyramid size={14} />
          </button>
          <button
            class={`left-sidebar__icon-btn${tab() === "templates" ? " left-sidebar__icon-btn--active" : ""}`}
            onClick={() => setTab("templates")}
            role="tab"
            aria-selected={tab() === "templates"}
            title={t("templates.title.templates")}
            aria-label={t("templates.title.templates")}
          >
            <Layers2 size={14} />
          </button>
          <button
            class={`left-sidebar__icon-btn${tab() === "packages" ? " left-sidebar__icon-btn--active" : ""}`}
            onClick={() => setTab("packages")}
            role="tab"
            aria-selected={tab() === "packages"}
            title={t("templates.title.packages")}
            aria-label={t("templates.title.packages")}
          >
            <Box size={14} />
          </button>
        </div>
        <div class="templates-pane__header-spacer" />
        <button
          class="left-sidebar__icon-btn"
          onClick={refresh}
          title={t("templates.refresh")}
          aria-label={t("templates.refresh")}
        >
          <RefreshCw size={14} />
        </button>
        <button
          class={`left-sidebar__icon-btn${showHelp() ? " left-sidebar__icon-btn--active" : ""}`}
          onClick={() => setShowHelp((v) => !v)}
          title={showHelp() ? t("templates.hideHelp") : t("templates.showHelp")}
          aria-label={t("templates.toggleHelp")}
          aria-pressed={showHelp()}
        >
          <Info size={14} />
        </button>
      </div>

      <div class="templates-pane__actions">
        <Show when={tab() === "scaffolds"}>
          <button
            class="templates-panel__new-btn"
            onClick={newScaffold}
            title={t("templates.newScaffoldTitle")}
          >
            <Plus size={12} /> {t("templates.new")}
          </button>
        </Show>
        <Show when={tab() === "templates"}>
          <button
            class="templates-panel__new-btn"
            onClick={() => newLocalPackage(true)}
            title={t("templates.newLocalTemplateTitle")}
          >
            <Plus size={12} /> {t("templates.new")}
          </button>
          <button
            class="templates-panel__new-btn"
            onClick={installBySpec}
            title={t("templates.installBySpecTitle")}
          >
            <Download size={12} /> {t("templates.install")}
          </button>
          <button
            class="templates-panel__new-btn"
            onClick={installFromFile}
            title={t("templates.installFromFileTitle")}
          >
            <FolderInput size={12} /> {t("templates.fromFile")}
          </button>
        </Show>
        <Show when={tab() === "packages"}>
          <button
            class="templates-panel__new-btn"
            onClick={() => newLocalPackage(false)}
            title={t("templates.newLocalPackageTitle")}
          >
            <Plus size={12} /> {t("templates.new")}
          </button>
          <button
            class="templates-panel__new-btn"
            onClick={installBySpec}
            title={t("templates.installBySpecTitle")}
          >
            <Download size={12} /> {t("templates.install")}
          </button>
          <button
            class="templates-panel__new-btn"
            onClick={installFromFile}
            title={t("templates.installFromFileTitle")}
          >
            <FolderInput size={12} /> {t("templates.fromFile")}
          </button>
        </Show>
      </div>

      <Show when={showHelp()}>
        <div class="templates-pane__help">
          <Show when={tab() === "scaffolds"}>
            <p>
              {t("templates.help.scaffoldsBefore")} <code>{`{{title}}`}</code>,{" "}
              <code>{`{{date}}`}</code>, <code>{`{{zid}}`}</code>,{" "}
              <code>{`{{cursor}}`}</code>{t("templates.help.scaffoldsAfter")}
            </p>
          </Show>
          <Show when={tab() === "templates"}>
            <p>
              {t("templates.help.templates1")} <code>{"typst.toml"}</code> {t("templates.help.templates2")}{" "}
              <code>{"[template]"}</code>{t("templates.help.templates3")}
            </p>
          </Show>
          <Show when={tab() === "packages"}>
            <p>
              {t("templates.help.packages1")}{" "}
              <code>{'#import "@preview/name:version": *'}</code>{t("templates.help.packages2")}{" "}
              <code>{".inkycap/packages/<ns>/<name>/<version>/"}</code>
              .
            </p>
          </Show>
        </div>
      </Show>

      <div class="templates-pane__body" ref={attachListNav} aria-label={t("templates.title")}>
        <Show when={tab() === "scaffolds"}>
          <Show
            when={!scaffolds.loading && (scaffolds() ?? []).length > 0}
            fallback={
              <Show when={!scaffolds.loading}>
                <p class="sidebar-hint">
                  {t("templates.empty.scaffoldsBefore")} <b>{t("templates.new")}</b> {t("templates.empty.scaffoldsAfter")}
                </p>
              </Show>
            }
          >
            <For each={scaffolds()}>
              {(entry) => (
                <div
                  data-list-item
                  class="sidebar-item templates-pane__item"
                  onClick={() => openScaffold(entry)}
                  title={t("templates.openScaffold")}
                >
                  <span class="sidebar-item__icon">
                    <Pyramid size={12} />
                  </span>
                  <span class="sidebar-item__label">{entry.name}</span>
                  <Show when={!entry.builtin}>
                    <button
                      class="templates-panel__item-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteScaffold(entry);
                      }}
                      title={t("templates.deleteScaffoldAria", { name: entry.name })}
                      aria-label={t("templates.deleteScaffoldAria", { name: entry.name })}
                    >
                      <Trash2 size={13} />
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </Show>

        <Show when={tab() === "templates"}>
          <Show
            when={!packages.loading && templatePackages().length > 0}
            fallback={
              <Show when={!packages.loading}>
                <p class="sidebar-hint">
                  {linkifyTerm(t("templates.empty.templatesBefore"), "Typst Universe", UNIVERSE_TEMPLATES_URL)} <code>{"@preview/charged-ieee:0.1.0"}</code>{t("templates.empty.templatesAfter")}
                </p>
              </Show>
            }
          >
            <For each={templatePackages()}>
              {(pkg) => (
                <div
                  data-list-item
                  class="sidebar-item templates-pane__item"
                  onClick={() => openPackageManifest(pkg)}
                  title={t("templates.openManifest")}
                >
                  <span class="sidebar-item__icon">
                    <Layers2 size={12} />
                  </span>
                  <span class="sidebar-item__label">
                    {pkg.name}{" "}
                    <span class="templates-panel__version">{pkg.version}</span>
                  </span>
                  <span class="templates-panel__badge">
                    {namespaceLabel(pkg.namespace, "template")}
                  </span>
                  <button
                    class="templates-panel__item-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyImport(packageImportLine(pkg));
                    }}
                    title={t("templates.copyTitle", { line: packageImportLine(pkg) })}
                  >
                    {t("templates.copy")}
                  </button>
                  <button
                    class="templates-panel__item-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      uninstall(pkg);
                    }}
                    title={t("templates.uninstallTitle", { spec: pkg.spec })}
                    aria-label={t("templates.uninstallTitle", { spec: pkg.spec })}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>

        <Show when={tab() === "packages"}>
          <Show
            when={!packages.loading && libraryPackages().length > 0}
            fallback={
              <Show when={!packages.loading}>
                <p class="sidebar-hint">
                  {linkifyTerm(t("templates.empty.packages1"), "Typst Universe", UNIVERSE_PACKAGES_URL)}{" "}
                  <code>{"@preview/cetz:0.2.0"}</code> {t("templates.empty.packages2")}{" "}
                  <code>{"@preview/codly:1.0.0"}</code> {t("templates.empty.packages3")}
                </p>
              </Show>
            }
          >
            <For each={libraryPackages()}>
              {(pkg) => (
                <div
                  data-list-item
                  class="sidebar-item templates-pane__item"
                  onClick={() => openPackageManifest(pkg)}
                  title={t("templates.openManifest")}
                >
                  <span class="sidebar-item__icon">
                    <Box size={12} />
                  </span>
                  <span class="sidebar-item__label">
                    {pkg.name}{" "}
                    <span class="templates-panel__version">{pkg.version}</span>
                  </span>
                  <span class="templates-panel__badge">
                    {namespaceLabel(pkg.namespace, "library")}
                  </span>
                  <button
                    class="templates-panel__item-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyImport(packageImportLine(pkg));
                    }}
                    title={t("templates.copyTitle", { line: packageImportLine(pkg) })}
                  >
                    {t("templates.copy")}
                  </button>
                  <button
                    class="templates-panel__item-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      uninstall(pkg);
                    }}
                    title={t("templates.uninstallTitle", { spec: pkg.spec })}
                    aria-label={t("templates.uninstallTitle", { spec: pkg.spec })}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </>
  );
};

export default TemplatesPanel;

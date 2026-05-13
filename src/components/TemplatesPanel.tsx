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
import { promptText } from "../stores/prompt";
import { toastError, showToast } from "../stores/toasts";

type SubTab = "scaffolds" | "templates" | "packages";

const TemplatesPanel: Component = () => {
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [tab, setTab] = createSignal<SubTab>("scaffolds");
  const [showHelp, setShowHelp] = createSignal(false);

  const [scaffolds] = createResource(
    () => refreshKey(),
    async () => ipc.listScaffoldEntries(),
  );
  const [packages] = createResource(
    () => refreshKey(),
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
      title: "New scaffold",
      label: "Filename",
      placeholder: "daily-note",
      hint: "A .typ extension is added if you omit it.",
      confirmLabel: "Create",
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
      toastError("Failed to create scaffold", e);
    }
  }

  async function installBySpec() {
    const spec = await promptText({
      title: "Install Typst Universe package",
      label: "Package spec",
      placeholder: "@preview/cetz:0.2.0",
      hint: "Fetched from packages.typst.org. Works for both templates and libraries.",
      confirmLabel: "Install",
    });
    if (!spec) return;
    try {
      const result = await ipc.installTypstPackageBySpec(spec);
      showToast(
        "success",
        `Installed ${result.spec} (${result.files_written} files)`,
      );
      refresh();
    } catch (e) {
      toastError("Failed to install package", e);
    }
  }

  async function installFromFile() {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const path = await openDialog({
      title: "Install Typst package from local archive",
      // Tauri filter extensions match the final dot-segment only — `tar.gz`
      // wouldn't match. List `gz`+`tgz`; backend validates actual shape.
      filters: [{ name: "Tarball", extensions: ["gz", "tgz"] }],
    });
    if (!path) return;
    try {
      const result = await ipc.installTypstPackageFromFile(path as string);
      showToast(
        "success",
        `Installed ${result.spec} (${result.files_written} files)`,
      );
      refresh();
    } catch (e) {
      toastError("Failed to install package", e);
    }
  }

  async function newLocalPackage(asTemplate: boolean) {
    const placeholder = asTemplate ? "letter-layout" : "my-utils";
    const spec = await promptText({
      title: asTemplate ? "New local template" : "New local package",
      label: "Name or spec",
      placeholder,
      hint: `Bare name becomes @local/<name>:0.1.0. You can also pass a full spec like @myorg/${placeholder}:1.0.0.`,
      confirmLabel: "Create",
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
        asTemplate ? "Failed to create template" : "Failed to create package",
        e,
      );
    }
  }

  function namespaceLabel(
    namespace: string,
    kind: "template" | "library",
  ): string {
    if (namespace === "preview") return "Typst Universe";
    if (namespace === "local") {
      return kind === "template" ? "Your template" : "Your package";
    }
    return `@${namespace}`;
  }

  async function uninstall(pkg: ipc.InstalledPackageEntry) {
    if (
      !window.confirm(
        `Uninstall ${pkg.spec}?\n\nThis deletes the package directory.`,
      )
    ) {
      return;
    }
    try {
      await ipc.uninstallTypstPackage(pkg.spec);
      showToast("success", `Uninstalled ${pkg.spec}`);
      refresh();
    } catch (e) {
      toastError("Failed to uninstall package", e);
    }
  }

  function copyImport(text: string) {
    navigator.clipboard.writeText(text).then(
      () => showToast("info", "Import line copied"),
      (err) => toastError("Failed to copy", err),
    );
  }

  function packageImportLine(pkg: ipc.InstalledPackageEntry): string {
    return `#import "${pkg.spec}": *`;
  }

  function title(): string {
    switch (tab()) {
      case "scaffolds":
        return "Scaffolds";
      case "templates":
        return "Document Templates";
      case "packages":
        return "Packages";
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
            title="Scaffolds"
            aria-label="Scaffolds"
          >
            <Pyramid size={14} />
          </button>
          <button
            class={`left-sidebar__icon-btn${tab() === "templates" ? " left-sidebar__icon-btn--active" : ""}`}
            onClick={() => setTab("templates")}
            role="tab"
            aria-selected={tab() === "templates"}
            title="Document Templates"
            aria-label="Document Templates"
          >
            <Layers2 size={14} />
          </button>
          <button
            class={`left-sidebar__icon-btn${tab() === "packages" ? " left-sidebar__icon-btn--active" : ""}`}
            onClick={() => setTab("packages")}
            role="tab"
            aria-selected={tab() === "packages"}
            title="Packages"
            aria-label="Packages"
          >
            <Box size={14} />
          </button>
        </div>
        <div class="templates-pane__header-spacer" />
        <button
          class="left-sidebar__icon-btn"
          onClick={refresh}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={14} />
        </button>
        <button
          class={`left-sidebar__icon-btn${showHelp() ? " left-sidebar__icon-btn--active" : ""}`}
          onClick={() => setShowHelp((v) => !v)}
          title={showHelp() ? "Hide help" : "Show help"}
          aria-label="Toggle help"
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
            title="New scaffold"
          >
            <Plus size={12} /> New
          </button>
        </Show>
        <Show when={tab() === "templates"}>
          <button
            class="templates-panel__new-btn"
            onClick={() => newLocalPackage(true)}
            title="New local template (@local/<name>:0.1.0)"
          >
            <Plus size={12} /> New
          </button>
        </Show>
        <Show when={tab() === "packages"}>
          <button
            class="templates-panel__new-btn"
            onClick={() => newLocalPackage(false)}
            title="New local package (@local/<name>:0.1.0)"
          >
            <Plus size={12} /> New
          </button>
          <button
            class="templates-panel__new-btn"
            onClick={installBySpec}
            title="Install from packages.typst.org by spec"
          >
            <Download size={12} /> Install
          </button>
          <button
            class="templates-panel__new-btn"
            onClick={installFromFile}
            title="Install from a local .tar.gz file"
          >
            <FolderInput size={12} /> From file
          </button>
        </Show>
      </div>

      <Show when={showHelp()}>
        <div class="templates-pane__help">
          <Show when={tab() === "scaffolds"}>
            <p>
              Note-body content. Supports <code>{`{{title}}`}</code>,{" "}
              <code>{`{{date}}`}</code>, <code>{`{{zid}}`}</code>,{" "}
              <code>{`{{cursor}}`}</code>. Insert into the current note with
              Ctrl+\.
            </p>
          </Show>
          <Show when={tab() === "templates"}>
            <p>
              Whole-document wrappers (page layout, fonts, styling). Typst
              packages whose <code>typst.toml</code> declares{" "}
              <code>[template]</code>. Install Universe templates from the
              Packages tab.
            </p>
          </Show>
          <Show when={tab() === "packages"}>
            <p>
              Typst Universe libraries (CeTZ for diagrams, codly for code
              blocks, etc.). Import with{" "}
              <code>#import "@preview/name:version": *</code>. Both packages
              and templates land under{" "}
              <code>
                .inkycap/packages/&lt;ns&gt;/&lt;name&gt;/&lt;version&gt;/
              </code>
              .
            </p>
          </Show>
        </div>
      </Show>

      <div class="templates-pane__body">
        <Show when={tab() === "scaffolds"}>
          <Show
            when={!scaffolds.loading && (scaffolds() ?? []).length > 0}
            fallback={
              <Show when={!scaffolds.loading}>
                <p class="sidebar-hint">
                  No scaffolds yet. Click <b>New</b> to create one.
                </p>
              </Show>
            }
          >
            <For each={scaffolds()}>
              {(entry) => (
                <div
                  class="sidebar-item"
                  onClick={() => openScaffold(entry)}
                  title="Open scaffold"
                >
                  <span class="sidebar-item__icon">
                    <Pyramid size={12} />
                  </span>
                  <span class="sidebar-item__label">{entry.name}</span>
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
                  No document templates yet. Install one from the Typst
                  Universe (e.g. <code>@preview/charged-ieee:0.1.0</code>) via
                  the Packages tab.
                </p>
              </Show>
            }
          >
            <For each={templatePackages()}>
              {(pkg) => (
                <div
                  class="sidebar-item templates-pane__item"
                  onClick={() => openPackageManifest(pkg)}
                  title="Open typst.toml"
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
                    title={`Copy: ${packageImportLine(pkg)}`}
                  >
                    Copy
                  </button>
                  <button
                    class="templates-panel__item-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      uninstall(pkg);
                    }}
                    title={`Uninstall ${pkg.spec}`}
                    aria-label={`Uninstall ${pkg.spec}`}
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
                  No libraries installed. Try{" "}
                  <code>@preview/cetz:0.2.0</code> for diagrams or{" "}
                  <code>@preview/codly:1.0.0</code> for code blocks.
                </p>
              </Show>
            }
          >
            <For each={libraryPackages()}>
              {(pkg) => (
                <div
                  class="sidebar-item templates-pane__item"
                  onClick={() => openPackageManifest(pkg)}
                  title="Open typst.toml"
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
                    title={`Copy: ${packageImportLine(pkg)}`}
                  >
                    Copy
                  </button>
                  <button
                    class="templates-panel__item-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      uninstall(pkg);
                    }}
                    title={`Uninstall ${pkg.spec}`}
                    aria-label={`Uninstall ${pkg.spec}`}
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

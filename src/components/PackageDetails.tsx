// The details shown under an expanded template or package row in the Templates
// panel: what its typst.toml says about it, links to read more, and the files
// that explain how to use it.

import { Component, For, Show, createResource, onCleanup } from "solid-js";
import { BookOpen, FileCode, FileCog, PackageSearch } from "lucide-solid";
import * as ipc from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/errors";
import { openFileInDefaultApp } from "../lib/open-link";
import { fetchImageObjectUrl } from "../lib/media-src";
import { activeNotePath, openTab } from "../stores/tabs";
import { showPackageReference } from "../stores/package-reference";
import { showToast, toastError } from "../stores/toasts";
import { ExternalLink } from "./ExternalLink";

const PackageDetails: Component<{
  pkg: ipc.InstalledPackageEntry;
  /** Where it comes from, e.g. "Typst Universe" or "Your template". */
  origin: string;
}> = (props) => {
  const t = useI18n();
  const [details] = createResource(
    () => props.pkg.spec,
    (spec) => ipc.getPackageDetails(spec),
  );
  // Reading a failed resource throws its error, so go through this instead.
  const loaded = () => (details.error ? undefined : details());
  const [thumbnail] = createResource(
    () => loaded()?.thumbnail_path ?? undefined,
    (path) => fetchImageObjectUrl(path).catch(() => null),
  );
  onCleanup(() => {
    const url = thumbnail();
    if (url) URL.revokeObjectURL(url);
  });

  function openInTab(path: string, title: string) {
    openTab({ type: "file", title, path }, { forceNewTab: false });
  }

  function openReference() {
    showPackageReference(props.pkg.spec);
    if (!activeNotePath()) showToast("info", t("templates.details.referenceNeedsNote"));
  }

  function openReadme(path: string) {
    openFileInDefaultApp(path).catch((err) =>
      toastError(t("editor.toast.openFailed"), err),
    );
  }

  return (
    <div class="templates-panel__details">
      <Show when={details.error}>
        <p class="templates-panel__details-meta">
          {t("templates.details.loadFailed")} {errorText(details.error)}
        </p>
      </Show>
      <Show when={loaded()}>
        {(d) => (
          <>
            <Show when={thumbnail()}>
              {(url) => (
                <img
                  class="templates-panel__thumbnail"
                  src={url()}
                  alt={t("templates.details.thumbnailAlt", { name: props.pkg.name })}
                />
              )}
            </Show>
            <Show when={d().description}>
              <p class="templates-panel__details-desc">{d().description}</p>
            </Show>
            <p class="templates-panel__details-meta">
              <span class="templates-panel__badge">{props.origin}</span>
              <Show when={d().authors.length > 0}>
                <span>{t("templates.details.by", { authors: d().authors.join(", ") })}</span>
              </Show>
              <Show when={d().license}>
                <span>{t("templates.details.licence", { licence: d().license ?? "" })}</span>
              </Show>
            </p>
            <Show when={d().universe_url || d().repository || d().homepage}>
              <p class="templates-panel__details-links">
                <Show when={d().universe_url}>
                  {(url) => (
                    <ExternalLink url={url()}>{t("templates.details.universe")}</ExternalLink>
                  )}
                </Show>
                <Show when={d().repository}>
                  {(url) => (
                    <ExternalLink url={url()}>{t("templates.details.repository")}</ExternalLink>
                  )}
                </Show>
                <Show when={d().homepage}>
                  {(url) => (
                    <ExternalLink url={url()}>{t("templates.details.homepage")}</ExternalLink>
                  )}
                </Show>
              </p>
            </Show>
            <div class="templates-panel__details-actions">
              <button
                class="btn btn--secondary btn--sm"
                onClick={openReference}
                title={t("templates.details.referenceTitle")}
              >
                <PackageSearch size={12} /> {t("templates.details.reference")}
              </button>
              <Show when={d().readme_path}>
                {(path) => (
                  <button
                    class="btn btn--secondary btn--sm"
                    onClick={() => openReadme(path())}
                    title={t("templates.details.readmeTitle")}
                  >
                    <BookOpen size={12} /> {t("templates.details.readme")}
                  </button>
                )}
              </Show>
              <Show when={d().starter_path}>
                {(path) => (
                  <button
                    class="btn btn--secondary btn--sm"
                    onClick={() =>
                      openInTab(path(), `${props.pkg.name}/${path().split("/").pop()}`)
                    }
                    title={t("templates.details.starterTitle")}
                  >
                    <FileCode size={12} /> {t("templates.details.starter")}
                  </button>
                )}
              </Show>
              <button
                class="btn btn--secondary btn--sm"
                onClick={() =>
                  openInTab(`${props.pkg.install_dir}/typst.toml`, `${props.pkg.name}/typst.toml`)
                }
                title={t("templates.details.manifestTitle")}
              >
                <FileCog size={12} /> {t("templates.openManifest")}
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

export default PackageDetails;

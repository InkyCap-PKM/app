// The References panel's "Source" section: a literature note's own reference
// (its `source: <key>`), formatted in the notebox's citation style, with a
// button that copies it as formatted Typst like "Copy formatted bibliography".
// Shown only for a note whose source is a reference.

import { Component, For, Show, createResource, onCleanup, onMount } from "solid-js";
import { ClipboardCopy } from "lucide-solid";
import * as ipc from "../lib/ipc";
import { errorText } from "../lib/errors";
import { pathEquals } from "../lib/paths";
import { useI18n } from "../lib/i18n";
import { noteboxSettings, settings } from "../stores/settings";
import { showToast } from "../stores/toasts";
import type { FormattedSpan } from "../lib/types";

interface SourceReferenceSectionProps {
  /** The note shown in the panel, if any. */
  path: string | undefined;
}

const SourceReferenceSection: Component<SourceReferenceSectionProps> = (props) => {
  const t = useI18n();

  const [source, { refetch }] = createResource(
    () => {
      // Re-format when the citation source or style changes.
      const _source = noteboxSettings.citations.source;
      const _bibPath = noteboxSettings.citations.bibliography_path;
      const _csl = noteboxSettings.citations.custom_csl_path;
      const _style = settings.citations.citation_style;
      return props.path;
    },
    async (path) => {
      if (!path) return null;
      try {
        return await ipc.getNoteSourceReference(path);
      } catch (err) {
        console.error("Failed to load the note's source reference:", err);
        return null;
      }
    },
  );

  // The source can change in the editor, the Properties tab or the References
  // menu ("Use as this note's source").
  onMount(() => {
    const onChanged = (e: Event) => {
      if (pathEquals((e as CustomEvent).detail?.path, props.path)) refetch();
    };
    for (const name of ["inkycap:note-saved", "inkycap:note-property-changed"]) {
      document.addEventListener(name, onChanged);
      onCleanup(() => document.removeEventListener(name, onChanged));
    }
  });

  async function copy() {
    const markup = source()?.markup;
    if (!markup) return;
    try {
      await navigator.clipboard.writeText(markup);
      showToast("success", t("references.copySourceDone"));
    } catch (err) {
      showToast("error", errorText(err));
    }
  }

  return (
    <Show when={source()}>
      {(ref) => (
        <div class="right-panel__section">
          <div class="right-panel__section-header">
            <span>{t("references.source")}</span>
            <Show when={ref().found}>
              <div class="right-panel__header-actions">
                <button
                  class="ui-icon-btn"
                  onClick={copy}
                  title={t("references.copySource")}
                  aria-label={t("references.copySource")}
                >
                  <ClipboardCopy size={14} />
                </button>
              </div>
            </Show>
          </div>
          <Show
            when={ref().found}
            fallback={
              <p class="sidebar-hint">{t("references.sourceNotFound", { key: ref().key })}</p>
            }
          >
            <div class="citation-row">
              <p class="source-reference">
                <For each={ref().formatted}>{(span) => <Span span={span} />}</For>
              </p>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
};

/** One styled run; a link opens in the browser. */
const Span: Component<{ span: FormattedSpan }> = (props) => {
  const classes = () => ({
    "source-reference__italic": props.span.italic,
    "source-reference__bold": props.span.bold,
    "source-reference__small-caps": props.span.small_caps,
  });
  return (
    <Show when={props.span.url} fallback={<span classList={classes()}>{props.span.text}</span>}>
      {(url) => (
        <a
          classList={classes()}
          href={url()}
          onClick={(e) => {
            e.preventDefault();
            void ipc.openUrlExternally(url());
          }}
        >
          {props.span.text}
        </a>
      )}
    </Show>
  );
};

export default SourceReferenceSection;

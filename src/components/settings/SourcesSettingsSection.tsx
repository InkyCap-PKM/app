// Sources tab: an acknowledgement of the open-source and free-culture work
// InkyCap is built on. Data-driven from the tables below — name, licence, and
// project URL per component, grouped by area — mirroring the bundled licence
// texts in `src-tauri/licenses/` (see that folder's README for the mapping).
import { For, Show, createSignal, createResource } from "solid-js";
import { ExternalLink } from "lucide-solid";
import * as ipc from "../../lib/ipc";
import { useI18n } from "../../lib/i18n";
import { toastError } from "../../stores/toasts";

interface SourceItem {
  /** Proper noun — rendered verbatim, not translated. */
  name: string;
  /** Short licence label — rendered verbatim (SPDX-style identifiers). */
  license: string;
  /** Project home page, opened in the OS browser. */
  url: string;
}

/** Components InkyCap redistributes, grouped by area. The `categoryKey`
 *  resolves to `settings.sources.category.*`. */
const CATEGORIES: { categoryKey: string; items: SourceItem[] }[] = [
  {
    categoryKey: "fonts",
    items: [
      { name: "Inter", license: "OFL 1.1", url: "https://rsms.me/inter/" },
      { name: "JuliaMono", license: "OFL 1.1", url: "https://juliamono.netlify.app/" },
      { name: "Junicode", license: "OFL 1.1", url: "https://github.com/psb1558/Junicode-font" },
      { name: "iA Writer Duospace", license: "OFL 1.1", url: "https://github.com/iaolo/iA-Fonts" },
      { name: "Libertinus", license: "OFL 1.1", url: "https://github.com/alerque/libertinus" },
      { name: "New Computer Modern", license: "GPL-3.0 + font exception", url: "https://ctan.org/pkg/newcomputermodern" },
      { name: "DejaVu Sans Mono", license: "Bitstream Vera", url: "https://dejavu-fonts.github.io/" },
    ],
  },
  {
    categoryKey: "typst",
    items: [
      { name: "Typst", license: "Apache-2.0", url: "https://github.com/typst/typst" },
      { name: "Tinymist", license: "Apache-2.0", url: "https://github.com/Myriad-Dreamin/tinymist" },
      { name: "typst-assets", license: "Apache-2.0", url: "https://github.com/typst/typst-assets" },
      { name: "codemirror-lang-typst", license: "Apache-2.0", url: "https://www.npmjs.com/package/codemirror-lang-typst" },
    ],
  },
  {
    categoryKey: "editor",
    items: [
      { name: "CodeMirror", license: "MIT", url: "https://codemirror.net/" },
      { name: "Solid.js", license: "MIT", url: "https://www.solidjs.com/" },
      { name: "@solid-primitives/i18n", license: "MIT", url: "https://github.com/solidjs-community/solid-primitives" },
      { name: "KaTeX", license: "MIT", url: "https://katex.org/" },
      { name: "Lucide", license: "ISC", url: "https://lucide.dev/" },
      { name: "Tauri", license: "MIT / Apache-2.0", url: "https://tauri.app/" },
    ],
  },
  {
    categoryKey: "spellcheck",
    items: [
      { name: "Hunspell", license: "MPL-1.1 / GPL-2.0 / LGPL-2.1", url: "https://hunspell.github.io/" },
      { name: "hunspell-asm", license: "MIT", url: "https://github.com/kwonoj/hunspell-asm" },
      { name: "English dictionaries (Marco A.G. Pinto)", license: "LGPL-3.0", url: "https://extensions.libreoffice.org/en/extensions/show/english-dictionaries" },
      { name: "French dictionary (Dicollecte / Olivier R.)", license: "MPL-2.0", url: "https://extensions.libreoffice.org/en/extensions/show/dictionnaires-francais" },
    ],
  },
  {
    categoryKey: "bibliography",
    items: [
      { name: "Hayagriva", license: "MIT / Apache-2.0", url: "https://github.com/typst/hayagriva" },
      { name: "biblatex", license: "MIT / Apache-2.0", url: "https://github.com/typst/biblatex" },
    ],
  },
  {
    categoryKey: "platform",
    items: [
      { name: "libgit2", license: "GPL-2.0 + linking exception", url: "https://libgit2.org/" },
      { name: "OpenSSL", license: "Apache-2.0", url: "https://www.openssl.org/" },
      { name: "SQLite", license: "Public Domain", url: "https://www.sqlite.org/" },
      { name: "pulldown-cmark", license: "MIT", url: "https://github.com/raphlinus/pulldown-cmark" },
    ],
  },
  {
    categoryKey: "mycelial",
    items: [
      { name: "stopwords-iso", license: "MIT", url: "https://github.com/stopwords-iso/stopwords-iso" },
    ],
  },
];

/** Methods and interaction conventions InkyCap implements itself: credited,
 *  but carrying no licence obligation. `descKey` resolves to
 *  `settings.sources.tech.*`. */
const TECHNIQUES: { name: string; descKey: string; url?: string }[] = [
  { name: "TF-IDF (Karen Spärck Jones)", descKey: "tfidf", url: "https://doi.org/10.1108/eb026526" },
  { name: "Pointwise Mutual Information (PMI)", descKey: "pmi" },
  { name: "F6 landmark cycling", descKey: "f6", url: "https://www.w3.org/WAI/ARIA/apg/" },
];

export function SourcesSettingsSection() {
  const t = useI18n();

  async function visit(url: string, name: string) {
    try {
      await ipc.openUrlExternally(url);
    } catch (e) {
      toastError(t("settings.sources.visitFailed", { name }), e);
    }
  }

  // The exhaustive, per-dependency notices (see src-tauri/licenses/). Loaded
  // lazily — only when the disclosure is opened, and re-fetched when the
  // Rust/JavaScript toggle changes; the source returns null while closed so
  // the file is never read until asked for.
  const [noticesKind, setNoticesKind] = createSignal<"rust" | "js">("rust");
  const [noticesOpen, setNoticesOpen] = createSignal(false);
  const [notices] = createResource(
    () => (noticesOpen() ? noticesKind() : null),
    (kind) => ipc.readThirdPartyNotices(kind),
  );

  return (
    <div class="settings__section">
      <div class="settings__section-header">
        <span class="settings__label">{t("settings.sources.heading")}</span>
      </div>
      <p class="settings__section-note">{t("settings.sources.intro")}</p>

      <For each={CATEGORIES}>
        {(cat) => (
          <>
            <div class="settings__section-header">
              <span class="settings__label">
                {t(`settings.sources.category.${cat.categoryKey}`)}
              </span>
            </div>
            <For each={cat.items}>
              {(item) => (
                <div class="settings__row">
                  <div class="settings__row-info">
                    <span class="settings__label">{item.name}</span>
                  </div>
                  <div class="settings__sources-actions">
                    <span class="badge">{item.license}</span>
                    <button
                      type="button"
                      class="ui-icon-btn"
                      aria-label={t("settings.sources.visit", { name: item.name })}
                      title={t("settings.sources.visit", { name: item.name })}
                      onClick={() => visit(item.url, item.name)}
                    >
                      <ExternalLink size={16} />
                    </button>
                  </div>
                </div>
              )}
            </For>
          </>
        )}
      </For>

      <div class="settings__section-header">
        <span class="settings__label">{t("settings.sources.techniques.heading")}</span>
      </div>
      <p class="settings__section-note">{t("settings.sources.techniques.intro")}</p>
      <For each={TECHNIQUES}>
        {(tech) => (
          <div class="settings__row">
            <div class="settings__row-info">
              <span class="settings__label">{tech.name}</span>
              <span class="settings__description">
                {t(`settings.sources.tech.${tech.descKey}`)}
              </span>
            </div>
            <Show when={tech.url}>
              <div class="settings__sources-actions">
                <button
                  type="button"
                  class="ui-icon-btn"
                  aria-label={t("settings.sources.visit", { name: tech.name })}
                  title={t("settings.sources.visit", { name: tech.name })}
                  onClick={() => visit(tech.url!, tech.name)}
                >
                  <ExternalLink size={16} />
                </button>
              </div>
            </Show>
          </div>
        )}
      </For>

      <div class="settings__section-header">
        <span class="settings__label">{t("settings.sources.notices.heading")}</span>
      </div>
      <p class="settings__section-note">{t("settings.sources.notices.intro")}</p>
      <button
        type="button"
        class="btn btn--secondary btn--sm"
        aria-expanded={noticesOpen()}
        onClick={() => setNoticesOpen((v) => !v)}
      >
        {noticesOpen() ? t("settings.sources.notices.hide") : t("settings.sources.notices.show")}
      </button>
      <Show when={noticesOpen()}>
        <div
          class="settings__segmented settings__notices-tabs"
          role="radiogroup"
          aria-label={t("settings.sources.notices.heading")}
        >
          <button
            type="button"
            role="radio"
            aria-checked={noticesKind() === "rust"}
            class={noticesKind() === "rust" ? "settings__segmented--active" : ""}
            onClick={() => setNoticesKind("rust")}
          >
            {t("settings.sources.notices.rust")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={noticesKind() === "js"}
            class={noticesKind() === "js" ? "settings__segmented--active" : ""}
            onClick={() => setNoticesKind("js")}
          >
            {t("settings.sources.notices.js")}
          </button>
        </div>
        <Show
          when={!notices.error}
          fallback={
            <p class="settings__section-note settings__section-note--warn">
              {t("settings.sources.notices.error")}
            </p>
          }
        >
          <pre class="settings__notices">
            {notices.loading ? t("settings.sources.notices.loading") : notices()}
          </pre>
        </Show>
      </Show>
    </div>
  );
}

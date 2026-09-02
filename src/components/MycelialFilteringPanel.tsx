// Concept Filtering pane for the Mycelial View's right panel.
//
// Two jobs, both about making the (otherwise invisible) stopword filtering
// legible and reversible:
//   1. Excluded terms — words that recur in this note's neighbourhood like a
//      real emergent concept but were held back by a stopword. The whole point
//      is discoverability: you can't rescue a word you didn't know was filtered.
//      Each row says *why* it was excluded and offers the matching rescue.
//   2. Stopwords — add your own words to ignore (moved here from the old legend
//      popup), plus a link to edit the full list on disk.
//
// Data flows in via the mycelial store (MycelialView publishes excluded terms
// when it loads); mutations call the backend then `requestMycelialReload()` so
// the graph and this list both refresh.
//
// A third section, Excluded notes, manages the notebox-wide exclusion rules:
// collection-style filter expressions where a note matching *any* rule takes
// no part in Mycelial calculations. The common case (exclude by tag) gets a
// one-click tag picker; anything else goes through the same property row
// editor the collection FilterBuilder uses.

import { Component, For, Show, createSignal, onMount } from "solid-js";
import * as ipc from "../lib/ipc";
import type { ExcludedTerm, MycelialExclusionInfo } from "../lib/types";
import { requestMycelialReload } from "../stores/mycelial";
import { toastError } from "../stores/toasts";
import { useI18n, tPlural } from "../lib/i18n";
import { Dropdown } from "./Dropdown";
import { FilterRowEditor } from "./FilterBuilder";
import { propertyLabel } from "../lib/property-labels";
import {
  FILTER_OPERATORS,
  type FilterRow,
  parseFilterRow,
  serializeFilterRow,
} from "../lib/filter-expr";

/** Recognizes the rule shape the tag picker writes, so those rules can render
 *  as "Tag: x" instead of a raw expression. */
const TAG_RULE = /^file\.tags\.contains\("(.*)"\)$/;

const EMPTY_ROW: FilterRow = { property: "", operator: "==", value: "" };

interface MycelialFilteringPanelProps {
  /** Suppressed terms for the focused Mycelial tab, resolved by the right panel
   *  from the tab-keyed store so split-pane views don't share one list. */
  excludedTerms: ExcludedTerm[];
}

const MycelialFilteringPanel: Component<MycelialFilteringPanelProps> = (props) => {
  const t = useI18n();
  const [draft, setDraft] = createSignal("");

  // ── Excluded notes (notebox-wide exclusion rules) ──
  const [exclusions, setExclusions] = createSignal<MycelialExclusionInfo | null>(null);
  const [allTags, setAllTags] = createSignal<[string, number][]>([]);
  const [allKeys, setAllKeys] = createSignal<string[]>([]);
  const [ruleDraft, setRuleDraft] = createSignal<FilterRow | null>(null);

  onMount(async () => {
    try {
      const [info, tags, keys] = await Promise.all([
        ipc.getMycelialExclusions(),
        ipc.getAllTags(),
        ipc.getAllPropertyKeys(),
      ]);
      setExclusions(info);
      setAllTags(tags);
      setAllKeys(keys);
    } catch (err) {
      toastError(t("mycelialFilter.exclusionLoadFailed"), err);
    }
  });

  async function saveRules(rules: string[]) {
    try {
      setExclusions(await ipc.setMycelialExclusions(rules));
      requestMycelialReload();
    } catch (err) {
      toastError(t("mycelialFilter.exclusionSaveFailed"), err);
    }
  }

  function addRule(expr: string) {
    const current = exclusions()?.rules ?? [];
    if (!expr || current.includes(expr)) return;
    saveRules([...current, expr]);
  }

  function removeRule(expr: string) {
    saveRules((exclusions()?.rules ?? []).filter((r) => r !== expr));
  }

  /** Tags that exist in the notebox and aren't already excluded. */
  function tagOptions() {
    const ruled = new Set(
      (exclusions()?.rules ?? [])
        .map((r) => r.match(TAG_RULE)?.[1])
        .filter((v): v is string => v !== undefined),
    );
    return allTags()
      .filter(([tag]) => !ruled.has(tag))
      .map(([tag, count]) => ({ value: tag, label: `${tag} (${count})` }));
  }

  /** Human-readable form of a rule: "Tag: x" for the tag-picker shape, the
   *  property/operator/value reading otherwise. */
  function ruleLabel(rule: string): string {
    const tag = rule.match(TAG_RULE)?.[1];
    if (tag !== undefined) return t("mycelialFilter.tagRule", { tag });
    const row = parseFilterRow(rule);
    const op = FILTER_OPERATORS.find((o) => o.value === row.operator);
    const opLabel = op ? t(op.labelKey) : row.operator;
    return `${propertyLabel(row.property)} ${opLabel} ${row.value}`.trim();
  }

  function confirmRuleDraft() {
    const row = ruleDraft();
    if (!row) return;
    const expr = serializeFilterRow(row);
    if (!expr) return;
    setRuleDraft(null);
    addRule(expr);
  }

  /** Rescue a suppressed term. A built-in stopword is force-included via the
   *  dictionary; a word the user added is removed from their stopword list. */
  async function rescue(term: ExcludedTerm) {
    try {
      if (term.source === "user") {
        await ipc.removeMycelialStopword(term.term);
      } else {
        await ipc.rescueMycelialTerm(term.term);
        // Rescue writes dictionary.txt, the shared user dictionary — let the
        // spellchecker pick up the new allow-listed word too.
        document.dispatchEvent(new CustomEvent("inkycap:dictionary-changed"));
      }
      requestMycelialReload();
    } catch (err) {
      toastError(t("mycelialFilter.rescueFailed"), err);
    }
  }

  async function addStopword() {
    const term = draft().trim();
    if (!term) return;
    setDraft("");
    try {
      await ipc.addMycelialStopword(term);
      requestMycelialReload();
    } catch (err) {
      toastError(t("mycelialFilter.addFailed"), err);
    }
  }

  /** Open the full stopword list in the OS default text editor (created with a
   *  format header on first use). */
  async function openStopwordFile() {
    try {
      const path = await ipc.ensureMycelialStopwordsFile();
      await ipc.openFileExternally(path);
    } catch (err) {
      toastError(t("mycelialFilter.openListFailed"), err);
    }
  }

  return (
    <div class="concept-filtering">
      <div class="right-panel__section">
        <div class="right-panel__section-header">
          <span>{t("mycelialFilter.excludedNotes")}</span>
          <div class="right-panel__header-actions" />
        </div>
        <p class="sidebar-hint">{t("mycelialFilter.excludedNotesHint")}</p>
        <Show
          when={(exclusions()?.rules.length ?? 0) > 0}
          fallback={<p class="sidebar-hint">{t("mycelialFilter.noExclusionRules")}</p>}
        >
          <div class="concept-filtering__list">
            <For each={exclusions()?.rules ?? []}>
              {(rule) => (
                <div class="concept-filtering__row">
                  <div class="concept-filtering__term">
                    <span class="concept-filtering__word" title={rule}>
                      {ruleLabel(rule)}
                    </span>
                  </div>
                  <button
                    class="concept-filtering__rescue"
                    onClick={() => removeRule(rule)}
                    title={t("mycelialFilter.removeRule")}
                  >
                    {t("common.remove")}
                  </button>
                </div>
              )}
            </For>
          </div>
          <p class="sidebar-hint">
            {t("mycelialFilter.excludedNotesCount", {
              excluded: exclusions()?.excluded_count ?? 0,
              total: exclusions()?.note_count ?? 0,
            })}
          </p>
        </Show>
        <Show when={tagOptions().length > 0}>
          <Dropdown<string>
            class="dropdown--block"
            value={""}
            options={tagOptions()}
            onChange={(tag) =>
              addRule(
                serializeFilterRow({
                  property: "file.tags",
                  operator: ".contains",
                  value: tag,
                }),
              )
            }
            placeholder={t("mycelialFilter.excludeTagPlaceholder")}
            ariaLabel={t("mycelialFilter.excludeTagPlaceholder")}
          />
        </Show>
        <Show
          when={ruleDraft()}
          fallback={
            <button
              class="concept-filtering__editlink"
              onClick={() => setRuleDraft({ ...EMPTY_ROW })}
            >
              {t("mycelialFilter.addPropertyRule")}
            </button>
          }
        >
          <div class="concept-filtering__rule-editor">
            <FilterRowEditor
              row={ruleDraft()!}
              allKeys={allKeys()}
              onChange={setRuleDraft}
              onRemove={() => setRuleDraft(null)}
            />
            <button
              class="btn btn--primary btn--sm"
              disabled={!ruleDraft()?.property.trim()}
              onClick={confirmRuleDraft}
            >
              {t("common.add")}
            </button>
          </div>
        </Show>
      </div>

      <div class="right-panel__section">
        <div class="right-panel__section-header">
          <span>{t("mycelialFilter.excludedTerms")}</span>
          <div class="right-panel__header-actions" />
        </div>
        <Show
          when={props.excludedTerms.length > 0}
          fallback={
            <p class="sidebar-hint">
              {t("mycelialFilter.empty")}
            </p>
          }
        >
          <div class="concept-filtering__list">
            <For each={props.excludedTerms}>
              {(term) => (
                <div class="concept-filtering__row">
                  <div class="concept-filtering__term">
                    <span class="concept-filtering__word">{term.term}</span>
                    <span class="concept-filtering__meta">
                      <span
                        class="concept-filtering__badge"
                        classList={{
                          "concept-filtering__badge--user": term.source === "user",
                        }}
                        title={
                          term.source === "user"
                            ? t("mycelialFilter.badgeUserTitle")
                            : t("mycelialFilter.badgeBuiltinTitle")
                        }
                      >
                        {term.source === "user" ? t("mycelialFilter.badgeUser") : t("mycelialFilter.badgeBuiltin")}
                      </span>
                      <span class="concept-filtering__count">
                        {tPlural("common.note", term.doc_count)}
                      </span>
                    </span>
                  </div>
                  <button
                    class="concept-filtering__rescue"
                    onClick={() => rescue(term)}
                    title={
                      term.source === "user"
                        ? t("mycelialFilter.rescueUserTitle")
                        : t("mycelialFilter.rescueBuiltinTitle")
                    }
                  >
                    {term.source === "user" ? t("common.remove") : t("mycelialFilter.rescue")}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="right-panel__section">
        <div class="right-panel__section-header">
          <span>{t("mycelialFilter.stopwords")}</span>
          <div class="right-panel__header-actions" />
        </div>
        <p class="sidebar-hint">{t("mycelialFilter.stopwordsHint")}</p>
        <div class="concept-filtering__add">
          <input
            class="property-editor__input"
            type="text"
            placeholder={t("mycelialFilter.addPlaceholder")}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addStopword();
              }
            }}
          />
          <button
            class="settings__detect-btn"
            disabled={!draft().trim()}
            onClick={addStopword}
          >
            {t("common.add")}
          </button>
        </div>
        <button class="concept-filtering__editlink" onClick={openStopwordFile}>
          {t("mycelialFilter.editList")}
        </button>
      </div>
    </div>
  );
};

export default MycelialFilteringPanel;

import { Component, createResource, createSignal, For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import * as ipc from "../lib/ipc";
import type { Contributor } from "../lib/types";
import { Dropdown } from "./Dropdown";
import { useI18n } from "../lib/i18n";

/// Sentinel value for the role select's "Other…" entry. A row in this mode
/// stores a free-text `biblio_role` the user types, instead of one of the
/// catalog's known role values.
const OTHER_ROLE = "__other__";

/// The NISO CRediT (Contributor Roles Taxonomy) reference, linked from the
/// "Include CRediT contributions statement" toggle.
const CREDIT_TAXONOMY_URL = "https://credit.niso.org/";

/// The Book Metadata contributors table: each row is a contributor with a
/// display name, a bibliographic role (drives the byline), and CRediT roles
/// (drive the optional contributions statement).
///
/// Backed by a `createStore` array so per-field edits are fine-grained: a
/// keystroke updates one cell in place without recreating the row's DOM
/// (a `<For>` over a freshly-mapped array would tear down and rebuild every
/// input each keystroke, stealing focus). Text fields commit to the parent
/// on blur; selects and add/remove commit immediately. The role vocabularies
/// come from the backend so they match what the export renderer understands.
const ContributorsEditor: Component<{
  initial: Contributor[];
  includeCreditStatement: boolean;
  onChange: (contributors: Contributor[], includeCreditStatement: boolean) => void;
}> = (props) => {
  const t = useI18n();
  const [catalogs] = createResource(() => ipc.contributorCatalogs());
  // Normalize the wire shape: the backend omits `credit_roles` from JSON when
  // it's empty (serde `skip_serializing_if`), so it can arrive `undefined`.
  // Coerce to a real array so every store row is well-formed and
  // spreads/`.length`/`.includes` are always safe.
  const [rows, setRows] = createStore<Contributor[]>(
    (props.initial ?? []).map((c) => ({
      ...c,
      credit_roles: Array.isArray(c.credit_roles) ? [...c.credit_roles] : [],
    })),
  );
  const [creditOn, setCreditOn] = createSignal(props.includeCreditStatement);
  // Which row's CRediT checklist is expanded (-1 = none).
  const [expanded, setExpanded] = createSignal(-1);

  const knownRoleValues = () =>
    new Set((catalogs()?.biblio_roles ?? []).map((o) => o.value));

  // What the role select should display for a stored value. Any non-null role
  // that isn't a catalog value (a custom string, or the empty placeholder set
  // when "Other…" was just chosen) shows as "Other…". Gated on the catalog
  // being loaded so a known role isn't briefly mistaken for custom on first
  // paint.
  const roleSelectValue = (role: string | null | undefined): string => {
    if (catalogs() && role != null && !knownRoleValues().has(role)) {
      return OTHER_ROLE;
    }
    return role || "author";
  };

  // Push current state up to the parent. Plain-object clones so the parent
  // never holds the store's reactive proxies.
  function flush() {
    props.onChange(
      rows.map((r) => ({ ...r, credit_roles: [...r.credit_roles] })),
      creditOn(),
    );
  }

  function addRow() {
    setRows(
      produce((arr) => {
        arr.push({ name: "", biblio_role: null, credit_roles: [] });
      }),
    );
    flush();
  }
  function removeRow(i: number) {
    setRows(produce((arr) => {
      arr.splice(i, 1);
    }));
    if (expanded() === i) setExpanded(-1);
    flush();
  }

  function toggleCredit(i: number, value: string, on: boolean) {
    const current = new Set(rows[i].credit_roles);
    if (on) current.add(value);
    else current.delete(value);
    setRows(i, "credit_roles", [...current]);
    flush();
  }

  return (
    <div class="contributors-editor">
      <For each={rows}>
        {(row, i) => (
          <div class="contributors-editor__row">
            <input
              type="text"
              class="settings__text-input contributors-editor__name"
              placeholder={t("contributors.namePlaceholder")}
              value={row.name}
              onInput={(e) => setRows(i(), "name", e.currentTarget.value)}
              onBlur={flush}
            />
            <Dropdown<string>
              class="contributors-editor__role"
              value={roleSelectValue(row.biblio_role)}
              options={[
                ...(catalogs()?.biblio_roles ?? []).map((o) => ({ value: o.value, label: o.label })),
                { value: OTHER_ROLE, label: t("common.other") },
              ]}
              onChange={(v) => {
                if (v === OTHER_ROLE) {
                  // Enter custom mode with an empty value; the text field
                  // below captures the typed role. An empty custom role is
                  // treated as "author" by the export renderer.
                  setRows(i(), "biblio_role", "");
                } else {
                  setRows(i(), "biblio_role", v === "author" ? null : v);
                }
                flush();
              }}
              ariaLabel={t("contributors.roleAria")}
            />
            <Show when={roleSelectValue(row.biblio_role) === OTHER_ROLE}>
              <input
                type="text"
                class="settings__text-input contributors-editor__role-other"
                placeholder={t("contributors.customRolePlaceholder")}
                value={row.biblio_role ?? ""}
                onInput={(e) => setRows(i(), "biblio_role", e.currentTarget.value)}
                onBlur={flush}
              />
            </Show>
            <button
              type="button"
              class="collection-table__toolbar-btn contributors-editor__btn"
              title={t("contributors.creditTitle")}
              onClick={() => setExpanded(expanded() === i() ? -1 : i())}
            >
              {t("contributors.creditBtn", { count: row.credit_roles.length })}
            </button>
            <button
              type="button"
              class="collection-table__toolbar-btn contributors-editor__btn contributors-editor__remove"
              title={t("contributors.remove")}
              onClick={() => removeRow(i())}
            >
              ✕
            </button>

            <Show when={expanded() === i()}>
              <div class="contributors-editor__credit">
                <For each={catalogs()?.credit_roles ?? []}>
                  {(opt) => (
                    <label class="contributors-editor__credit-item">
                      <input
                        type="checkbox"
                        checked={row.credit_roles.includes(opt.value)}
                        onChange={(e) => toggleCredit(i(), opt.value, e.currentTarget.checked)}
                      />
                      {opt.label}
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>

      <div class="collection-meta__row contributors-editor__actions">
        <button type="button" class="collection-table__toolbar-btn contributors-editor__btn" onClick={addRow}>
          {t("contributors.add")}
        </button>
      </div>

      <label class="contributors-editor__credit-toggle">
        <input
          type="checkbox"
          checked={creditOn()}
          onChange={(e) => {
            setCreditOn(e.currentTarget.checked);
            flush();
          }}
        />
        <span>
          {(() => {
            // Render "CRediT" as a link to the NISO taxonomy without making it
            // a separate translation unit: the surrounding sentence stays one
            // string with a `{credit}` slot, and we splice the link in.
            const [before, after] = t("contributors.includeCreditStatement").split("{credit}");
            return (
              <>
                {before}
                <a
                  href={CREDIT_TAXONOMY_URL}
                  target="_blank"
                  rel="noreferrer"
                  class="inline-link"
                  onClick={(e) => {
                    // Don't let the click bubble to the <label> and toggle the
                    // checkbox; open the taxonomy in the user's browser instead.
                    e.preventDefault();
                    e.stopPropagation();
                    void ipc.openUrlExternally(CREDIT_TAXONOMY_URL);
                  }}
                >
                  {t("contributors.creditLinkText")}
                </a>
                {after}
              </>
            );
          })()}
        </span>
      </label>
    </div>
  );
};

export default ContributorsEditor;

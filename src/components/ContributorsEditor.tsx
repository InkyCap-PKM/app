import { Component, createResource, createSignal, For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import * as ipc from "../lib/ipc";
import type { Contributor } from "../lib/types";
import { Dropdown } from "./Dropdown";

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
              placeholder="Name"
              value={row.name}
              onInput={(e) => setRows(i(), "name", e.currentTarget.value)}
              onBlur={flush}
            />
            <Dropdown<string>
              class="contributors-editor__role"
              value={row.biblio_role || "author"}
              options={(catalogs()?.biblio_roles ?? []).map((o) => ({ value: o.value, label: o.label }))}
              onChange={(v) => {
                setRows(i(), "biblio_role", v === "author" ? null : v);
                flush();
              }}
              ariaLabel="Bibliographic role"
            />
            <button
              type="button"
              class="collection-table__toolbar-btn contributors-editor__btn"
              title="CRediT contribution roles"
              onClick={() => setExpanded(expanded() === i() ? -1 : i())}
            >
              CRediT ({row.credit_roles.length})
            </button>
            <button
              type="button"
              class="collection-table__toolbar-btn contributors-editor__btn contributors-editor__remove"
              title="Remove contributor"
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
          + Add contributor
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
        Include CRediT contributions statement in book export
      </label>
    </div>
  );
};

export default ContributorsEditor;

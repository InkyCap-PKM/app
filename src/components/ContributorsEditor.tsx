import { Component, createResource, createSignal, For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import * as ipc from "../lib/ipc";
import type { Contributor } from "../lib/types";
import { Dropdown } from "./Dropdown";
import { settings } from "../stores/settings";

/// The Book Metadata contributors table: each row is a contributor with a
/// display name, a bibliographic role (drives the byline), CRediT roles
/// (drive the optional contributions statement), and an "editing
/// collaborator" flag that mints a frozen identity handle.
///
/// Backed by a `createStore` array so per-field edits are fine-grained: a
/// keystroke updates one cell in place without recreating the row's DOM
/// (a `<For>` over a freshly-mapped array would tear down and rebuild every
/// input each keystroke, stealing focus). Text fields commit to the parent
/// on blur; selects, checkboxes, and add/remove commit immediately. The role
/// vocabularies come from the backend so they match what the export renderer
/// understands.
const ContributorsEditor: Component<{
  initial: Contributor[];
  includeCreditStatement: boolean;
  onChange: (contributors: Contributor[], includeCreditStatement: boolean) => void;
}> = (props) => {
  const [catalogs] = createResource(() => ipc.contributorCatalogs());
  // Normalize the wire shape: the backend omits `credit_roles` from JSON when
  // it's empty (serde `skip_serializing_if`), so it can arrive `undefined`.
  // Coerce to a real array (and default the collaborator flag) so every store
  // row is well-formed and spreads/`.length`/`.includes` are always safe.
  const [rows, setRows] = createStore<Contributor[]>(
    (props.initial ?? []).map((c) => ({
      ...c,
      credit_roles: Array.isArray(c.credit_roles) ? [...c.credit_roles] : [],
      is_collaborator: c.is_collaborator ?? false,
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
    // The first contributor defaults to the user's global Author Name (set in
    // Settings › Overview › Collaboration) — "you, as first author" is the
    // common case. Later rows start blank.
    const defaultName = rows.length === 0 ? settings.collaboration.author_name.trim() : "";
    setRows(
      produce((arr) => {
        arr.push({ name: defaultName, biblio_role: null, credit_roles: [], is_collaborator: false, handle: null });
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

  async function toggleCollaborator(i: number, on: boolean) {
    let handle = rows[i].handle ?? null;
    // Mint a handle the first time a row becomes a collaborator; thereafter
    // it's frozen (renaming the person doesn't disturb version history).
    if (on && !handle) {
      // When this row is "you" (its name matches the global Author Name) and a
      // global handle is set, reuse it so your contributor row and your collab
      // identity agree. Otherwise seed a fresh handle from the name.
      const globalName = settings.collaboration.author_name.trim();
      const globalHandle = settings.collaboration.handle.trim();
      const rowName = rows[i].name.trim();
      if (globalHandle && rowName && rowName === globalName) {
        handle = globalHandle;
      } else {
        const taken = rows
          .filter((_, idx) => idx !== i)
          .map((r) => r.handle)
          .filter((h): h is string => !!h);
        try {
          handle = await ipc.collabSeedHandle(rows[i].name, taken);
        } catch {
          handle = null;
        }
      }
    }
    setRows(i, { is_collaborator: on, handle });
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
            <label class="contributors-editor__collab" title="Editing collaborator (package handoff)">
              <input
                type="checkbox"
                checked={row.is_collaborator}
                onChange={(e) => toggleCollaborator(i(), e.currentTarget.checked)}
              />
              Collaborator
            </label>
            <button
              type="button"
              class="collection-table__toolbar-btn contributors-editor__btn contributors-editor__remove"
              title="Remove contributor"
              onClick={() => removeRow(i())}
            >
              ✕
            </button>

            <Show when={row.is_collaborator}>
              <input
                type="text"
                class="settings__text-input contributors-editor__handle"
                placeholder="handle"
                value={row.handle ?? ""}
                onInput={(e) => setRows(i(), "handle", e.currentTarget.value || null)}
                onBlur={flush}
                title="Frozen identity handle used in version history"
              />
            </Show>

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

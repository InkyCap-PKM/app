import { Component, createResource, createSignal, Show } from "solid-js";
import { ask } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import type { CollabState } from "../lib/types";
import { showToast } from "../stores/toasts";
import { settings } from "../stores/settings";
import { propertyVersion, bumpPropertyVersion } from "../stores/notebox";
import { promptText } from "../stores/prompt";
import CollabPanel from "./CollabPanel";

/// The right-panel Collaboration surface for a Collection View. Owns the
/// Disable / Pause / Enable lifecycle pill and the enable flow (handle
/// resolution, destructive-disable confirm); the post-enable controls render
/// in `CollabPanel` below the pill.
///
/// State lives entirely on disk (the `.inkycap/collab` sidecar + the
/// collection's `collaboration.enabled` flag); `collab_status` reports the
/// tri-state. After any transition we `bumpPropertyVersion()` so the
/// CollectionTable's filter lock and member list refetch, and refetch the
/// local status/collection-file resources.

/// Derive a filename-safe handle seed from a display name for the prompt's
/// initial value (lowercase, spaces/punctuation → single hyphens). Only a
/// convenience default — the backend mints the authoritative form when
/// needed; the user can edit it freely in the prompt.
function handleSeed(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const CollaborationSection: Component<{
  collectionPath: string;
  collectionName: string;
}> = (props) => {
  const [busy, setBusy] = createSignal(false);

  // Keyed on propertyVersion so a transition (which bumps it) refetches.
  const [status, { refetch: refetchStatus }] = createResource(
    () => [props.collectionPath, propertyVersion()] as const,
    ([p]) => ipc.collabStatus(p),
  );
  const [collectionFile, { refetch: refetchCollectionFile }] = createResource(
    () => [props.collectionPath, propertyVersion()] as const,
    ([p]) => ipc.getCollectionFile(p),
  );

  const state = (): CollabState => status()?.state ?? "disabled";
  const refresh = () => {
    refetchStatus();
    refetchCollectionFile();
  };

  /// Resolve the handle to enable with: the collection's pinned identity, then
  /// the global default, then a prompt (seeded from the global author name).
  /// Returns null if the user cancels the prompt.
  async function resolveHandle(): Promise<string | null> {
    const pinned = status()?.handle?.trim();
    if (pinned) return pinned;
    const global = settings.collaboration.handle.trim();
    if (global) return global;
    const seed = handleSeed(settings.collaboration.author_name);
    const entered = await promptText({
      title: "Your collaborator handle",
      label: "Handle",
      initialValue: seed,
      placeholder: "e.g. athena-babel",
      hint: "Identifies your edits when collaborating. Stays on this machine. Set a default in Settings › Overview › Collaboration.",
      confirmLabel: "Enable",
    });
    const h = entered?.trim();
    return h ? h : null;
  }

  async function setTo(target: CollabState) {
    if (busy() || target === state()) return;
    setBusy(true);
    try {
      if (target === "disabled") {
        const confirmed = await ask(
          "Disable collaboration for this collection? Your notes are kept, but the version-tracking history and identity are deleted. You can re-enable later, but history will start fresh. Choose Pause instead to keep history.",
          { title: "Disable collaboration", kind: "warning" },
        );
        if (!confirmed) return;
        await ipc.collabSetState(props.collectionPath, "disabled");
        showToast("success", "Collaboration disabled");
      } else {
        // Enabling always needs a handle; pausing only needs one when there's
        // no sidecar yet (Disabled → Pause prepares it inactive).
        let handle: string | undefined;
        if (target === "enabled" || state() === "disabled") {
          const h = await resolveHandle();
          if (!h) return; // cancelled
          handle = h;
        }
        const r = await ipc.collabSetState(props.collectionPath, target, handle);
        if (target === "enabled") {
          showToast(
            "success",
            state() === "paused" ? "Collaboration resumed" : "Collaboration enabled",
            `${r.members} member notes, ${r.stamped} newly stamped.`,
          );
        } else {
          showToast("success", "Collaboration paused", "History kept — resume any time.");
        }
      }
      // Sync the CollectionTable (filter lock + member rows) and our resources.
      bumpPropertyVersion();
      refresh();
    } catch (e) {
      showToast("error", "Couldn't change collaboration", String(e));
    } finally {
      setBusy(false);
    }
  }

  const seg = (target: CollabState, label: string) => (
    <button
      type="button"
      class="collab-state-pill__seg"
      classList={{ "is-active": state() === target }}
      aria-pressed={state() === target}
      disabled={busy()}
      onClick={() => setTo(target)}
    >
      {label}
    </button>
  );

  return (
    <div class="collab-section">
      <div class="collab-section__header">
        <span class="collab-section__title">Collaboration</span>
      </div>

      <div class="collab-section__enable-row">
        <span class="collab-section__question">
          Enable collaboration for this collection?
        </span>
        <div class="collab-state-pill" role="group" aria-label="Collaboration state">
          {seg("disabled", "Disable")}
          {seg("paused", "Pause")}
          {seg("enabled", "Enable")}
        </div>
      </div>

      <Show when={state() === "paused"}>
        <div class="collection-meta__row">
          <span class="collection-meta__hint">
            Paused — your version history is kept. Choose Enable to resume
            packaging and importing changes.
          </span>
        </div>
      </Show>

      <Show when={state() === "enabled" && status() && collectionFile()}>
        <CollabPanel
          collectionPath={props.collectionPath}
          collectionName={props.collectionName}
          status={status()!}
          collectionFile={collectionFile()!}
          onChanged={refresh}
        />
      </Show>
    </div>
  );
};

export default CollaborationSection;

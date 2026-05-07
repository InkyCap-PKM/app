import { Component, createSignal, createEffect, For, Show } from "solid-js";
import * as ipc from "../lib/ipc";
import type { SnapshotInfo } from "../lib/types";

interface SnapshotViewerProps {
  filePath: string;
  visible: boolean;
  onClose: () => void;
  onRestore: (content: string) => void;
}

const SnapshotViewer: Component<SnapshotViewerProps> = (props) => {
  const [snapshots, setSnapshots] = createSignal<SnapshotInfo[]>([]);
  const [selectedHash, setSelectedHash] = createSignal<string | null>(null);
  const [previewContent, setPreviewContent] = createSignal<string>("");
  const [loading, setLoading] = createSignal(false);

  const loadSnapshots = async () => {
    try {
      const result = await ipc.listSnapshots(props.filePath);
      setSnapshots(result);
    } catch (e) {
      console.error("Failed to load snapshots:", e);
    }
  };

  // Reload snapshots each time the viewer becomes visible
  createEffect(() => {
    if (props.visible && props.filePath) {
      setSelectedHash(null);
      setPreviewContent("");
      loadSnapshots();
    }
  });

  const selectSnapshot = async (hash: string) => {
    setSelectedHash(hash);
    try {
      const preview = await ipc.previewSnapshot(props.filePath, hash, 500);
      setPreviewContent(preview);
    } catch (e) {
      console.error("Failed to preview snapshot:", e);
      setPreviewContent("Failed to load preview.");
    }
  };

  const handleRestore = async () => {
    const hash = selectedHash();
    if (!hash) return;

    setLoading(true);
    try {
      const content = await ipc.restoreSnapshot(props.filePath, hash);
      props.onRestore(content);
      props.onClose();
    } catch (e) {
      console.error("Failed to restore snapshot:", e);
    } finally {
      setLoading(false);
    }
  };

  const formatTimestamp = (ts: string): string => {
    try {
      const date = new Date(ts);
      return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return ts;
    }
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <Show when={props.visible}>
      <div class="snapshot-viewer-overlay" onClick={props.onClose}>
        <div class="snapshot-viewer" onClick={(e) => e.stopPropagation()}>
          <div class="snapshot-viewer__header">
            <h3>File History</h3>
            <button class="snapshot-viewer__close" onClick={props.onClose}>
              {"\u00D7"}
            </button>
          </div>

          <div class="snapshot-viewer__body">
            <div class="snapshot-viewer__timeline">
              <Show
                when={snapshots().length > 0}
                fallback={
                  <p class="snapshot-viewer__empty">
                    No snapshots yet. Snapshots are created automatically when
                    you save changes.
                  </p>
                }
              >
                <For each={snapshots()}>
                  {(snapshot) => (
                    <button
                      class={`snapshot-entry${selectedHash() === snapshot.hash ? " snapshot-entry--selected" : ""}`}
                      onClick={() => selectSnapshot(snapshot.hash)}
                    >
                      <span class="snapshot-entry__time">
                        {formatTimestamp(snapshot.timestamp)}
                      </span>
                      <span class="snapshot-entry__size">
                        {formatSize(snapshot.size)}
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </div>

            <div class="snapshot-viewer__preview">
              <Show
                when={selectedHash()}
                fallback={
                  <p class="snapshot-viewer__hint">
                    Select a snapshot to preview
                  </p>
                }
              >
                <pre class="snapshot-viewer__content">{previewContent()}</pre>
              </Show>
            </div>
          </div>

          <Show when={selectedHash()}>
            <div class="snapshot-viewer__footer">
              <button
                class="snapshot-viewer__restore-btn"
                onClick={handleRestore}
                disabled={loading()}
              >
                {loading() ? "Restoring..." : "Restore This Version"}
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

export default SnapshotViewer;

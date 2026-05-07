import { Component, Show } from "solid-js";
import { vaultInfo, pickAndOpenVault } from "../stores/vault";
import { wordCountStats } from "../editor/typst-decorations/word-count";
import { getActiveTab } from "../stores/tabs";

const StatusBar: Component = () => {
  const isFileTab = () => getActiveTab()?.type === "file";
  const stats = wordCountStats;

  return (
    <div class="status-bar">
      <Show when={vaultInfo()} fallback={<span>No vault open</span>}>
        {(info) => (
          <>
            <button
              class="status-bar__vault-name"
              onClick={() => pickAndOpenVault()}
              title="Change vault"
            >
              {info().name}
            </button>
            <span>{info().file_count} files</span>
            <span>{info().collection_count} collections</span>
          </>
        )}
      </Show>
      <div class="status-bar__spacer" />

      <Show when={isFileTab()}>
        <span class="status-bar__stat">
          {stats().words} words
        </span>
        <span class="status-bar__stat">
          {stats().chars} chars
        </span>
        <span class="status-bar__stat">
          ~{stats().readingTime} min read
        </span>
      </Show>
    </div>
  );
};

export default StatusBar;

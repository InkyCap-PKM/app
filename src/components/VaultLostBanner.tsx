// Persistent top-of-app warning shown when the backend's vault health
// monitor reports that the active vault directory has been deleted (OS
// file manager, `rm -rf`, unmounted drive, etc.).
//
// The banner stays visible until another vault is opened — there is no
// dismiss button, because the warning is load-bearing: any save attempt
// will fail until the user opens a different vault, and we don't want
// the user to lose work to a misclick.
//
// Save gating happens at the IPC layer (see `assertVaultWritable` in
// stores/vault.ts); this component is purely UI.

import { Component, Show } from "solid-js";
import { AlertTriangle } from "lucide-solid";
import { vaultLost } from "../stores/vault";

const VaultLostBanner: Component = () => {
  return (
    <Show when={vaultLost()}>
      {(path) => (
        <div class="vault-lost-banner" role="alert" aria-live="assertive">
          <AlertTriangle size={18} class="vault-lost-banner__icon" />
          <div class="vault-lost-banner__body">
            <span class="vault-lost-banner__title">
              Vault is missing from disk
            </span>
            <span class="vault-lost-banner__detail">
              <span class="vault-lost-banner__path">{path()}</span>{" "}
              no longer exists. Your open notes cannot be saved — copy any
              content you want to keep into another location or vault.
            </span>
          </div>
        </div>
      )}
    </Show>
  );
};

export default VaultLostBanner;

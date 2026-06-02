// Left-sidebar Git Collaboration pane (Phase 5: the Sync model).
//
// Two states, chosen by whether the open notebox carries a git config:
//   • not collaborative → a setup form (remote, branch, sign-in, identity).
//   • collaborative     → status + the two gestures: Sync (pull + merge + push)
//     and Check for updates (pull + merge, no push).
//
// After a sync, a non-blocking digest lists what collaborators changed. When a
// merge conflicts, the conflicted notes are listed and open as staged tabs
// (the existing suggestion pills + the right-panel Annotations pane resolve
// them); "Finalize" then commits the merged result and — for a Sync — pushes.

import { Component, Show, For, createSignal, createResource, onMount, onCleanup } from "solid-js";
import {
  Check,
  ArrowUp,
  ArrowDown,
  Pencil,
  Plus,
  Trash2,
  RefreshCw,
  DownloadCloud,
  FolderUp,
  FolderDown,
  ChevronDown,
  ChevronRight,
  Settings2,
  RotateCcw,
  ArrowRightLeft,
} from "lucide-solid";
import HelpButton from "./HelpButton";
import LoadingDots from "./LoadingDots";
import { noteboxSettings } from "../stores/settings";
import {
  collaborative,
  packageMode,
  repoMissing,
  reconnectable,
  gitStatus,
  syncOutcome,
  incomingCount,
  gitSyncing,
  sync,
  checkUpdates,
  refreshStatus,
  setupCollaboration,
  setupPackageHandoff,
  reconnectCollaboration,
  getDefaultIdentity,
  disableCollaboration,
  manageOpen,
  setManageOpen,
  actionsOpen,
  setActionsOpen,
  bundlePackages,
  setBundlePackages,
  unresolvedFiles,
  changesSinceSync,
  revertNoteSinceSync,
} from "../stores/git";
import { openTab, getActiveTab } from "../stores/tabs";
import { setRightCollapsed, setRightPanelTab } from "../stores/layout";
import type { GitDigestEntry } from "../lib/types";
import { gitChangesToShare, gitSavedUsername } from "../lib/ipc";
import { exportPackageInteractive, importPackageInteractive } from "../lib/package-handoff";
import { looksLikeSshRemote, toHttpsRemote, toSshRemote } from "../lib/git-remote";

/** Truncate a JSON value to a short, single-line preview for a settings chip. */
function fmtSettingValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}
import { showToast, toastError } from "../stores/toasts";
import { promptConfirm, promptConfirmWithCheckbox } from "../stores/prompt";
import { t, tPlural } from "../lib/i18n";

/** Icon for a change kind (mirrors the inline suggestion tones). */
function kindIcon(kind: GitDigestEntry["status"]) {
  switch (kind) {
    case "added":
      return <Plus size={14} />;
    case "deleted":
      return <Trash2 size={14} />;
    case "renamed":
      return <ArrowRightLeft size={14} />;
    default:
      return <Pencil size={14} />;
  }
}

/** Row label for a changed file: a rename shows "old → new", everything else
 *  just the basename. */
function fileBasename(p: string): string {
  return p.split("/").pop() ?? p;
}
function changeLabel(newPath: string, oldPath?: string | null): string {
  return oldPath ? `${fileBasename(oldPath)} → ${fileBasename(newPath)}` : fileBasename(newPath);
}

const GitCollaborationPanel: Component = () => {
  // Re-check git status whenever the panel opens, so a state change made
  // outside the app (e.g. the `.git` dir deleted) is reflected without a
  // notebox reopen.
  onMount(() => {
    if (collaborative()) void refreshStatus();
  });
  // Collapse the Manage section when the user leaves the collaboration view, so
  // it always reopens collapsed (the Settings › Configure entry still expands it
  // explicitly, after this unmounts).
  onCleanup(() => setManageOpen(false));
  return (
    <>
      <div class="left-sidebar__section-header">
        <span>{t("git.panel.title")}</span>
      </div>
      <Show when={collaborative() && !repoMissing()} fallback={<SetupForm />}>
        <SyncView />
      </Show>
    </>
  );
};

// ─────────────────────────── Setup form ────────────────────────────────────

const SetupForm: Component = () => {
  // Pre-fill from an existing config when re-initializing a notebox whose repo
  // is missing (deleted `.git`, or settings that travelled without the repo).
  const existing = noteboxSettings.git;
  const [remote, setRemote] = createSignal(existing?.remote ?? "");
  const [branch, setBranch] = createSignal(existing?.branch ?? "main");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [name, setName] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // Offline package handoff: collaborate with no git server (empty remote).
  // Pre-checked when re-initializing a notebox that was already package-mode.
  const [offline, setOffline] = createSignal(existing != null && existing.remote.trim() === "");
  // Advanced: connect over SSH (using the computer's existing SSH keys) instead
  // of a username + password. Pre-checked when the existing remote is an SSH URL.
  const [useSsh, setUseSsh] = createSignal(looksLikeSshRemote(existing?.remote ?? ""));

  // Pre-fill the identity from the one InkyCap would use (your git config), and
  // the saved sign-in username for this remote (if any), so neither is a mystery
  // blank — edit them to use different values here.
  onMount(async () => {
    const id = await getDefaultIdentity();
    if (id) {
      if (!name().trim()) setName(id.name);
      if (!email().trim()) setEmail(id.email);
    }
    const r = remote().trim();
    if (r) {
      const saved = await gitSavedUsername(r).catch(() => null);
      if (saved && !username().trim()) setUsername(saved);
    }
  });

  async function submit() {
    if (!offline() && !remote().trim()) {
      toastError(t("git.setup.failed"), t("git.setup.remoteRequired"));
      return;
    }
    setBusy(true);
    try {
      if (offline()) {
        await setupPackageHandoff({
          branch: branch().trim() || "main",
          identityName: name().trim() || undefined,
          identityEmail: email().trim() || undefined,
        });
      } else {
        await setupCollaboration({
          remote: remote().trim(),
          branch: branch().trim() || "main",
          identityName: name().trim() || undefined,
          identityEmail: email().trim() || undefined,
          // SSH authenticates with keys, not a username/password.
          username: useSsh() ? undefined : username().trim() || undefined,
          password: useSsh() ? undefined : password().trim() || undefined,
        });
      }
      showToast("success", t("git.setup.done"));
    } catch (err) {
      toastError(t("git.setup.failed"), err);
    } finally {
      setBusy(false);
    }
  }

  const [reconnecting, setReconnecting] = createSignal(false);
  async function reconnect() {
    setReconnecting(true);
    try {
      await reconnectCollaboration();
      showToast("success", t("git.reconnect.done"));
    } catch (err) {
      toastError(t("git.reconnect.failed"), err);
    } finally {
      setReconnecting(false);
    }
  }

  return (
    <div class="git-panel__body git-panel__setup">
      {/* This notebox is already a git repo with a remote but has no collab
          config — offer to adopt it in one click before the manual form. */}
      <Show when={!repoMissing() && reconnectable()}>
        {(info) => (
          <div class="git-panel__reconnect">
            <p class="sidebar-hint">
              {t("git.reconnect.intro", { remote: info().remote, branch: info().branch })}
            </p>
            <button class="git-panel__primary-btn" onClick={reconnect} disabled={reconnecting()}>
              {reconnecting() ? t("git.reconnect.working") : t("git.reconnect.action")}
            </button>
          </div>
        )}
      </Show>

      <Show
        when={repoMissing()}
        fallback={<p class="sidebar-hint">{t("git.setup.intro")}</p>}
      >
        <p class="sidebar-hint git-panel__repair-hint">{t("git.setup.repairHint")}</p>
      </Show>

      {/* Offline package handoff: collaborate with no git server. Hides the
          repository + sign-in fields; sharing happens by exporting/importing a file. */}
      <div class="git-panel__label-row git-panel__toggle-row">
        <label class="settings__label">{t("git.setup.offlineLabel")}</label>
        <HelpButton label={t("git.setup.offlineLabel")}>{t("git.setup.offlineHint")}</HelpButton>
        <label class="settings__toggle" title={t("git.setup.offlineHint")}>
          <input
            type="checkbox"
            checked={offline()}
            onChange={(e) => setOffline(e.currentTarget.checked)}
          />
          <span class="settings__toggle-slider" />
        </label>
      </div>

      <Show when={!offline()}>
        <div class="git-panel__label-row">
          <label class="settings__label" for="git-remote">
            {useSsh() ? t("git.setup.remoteLabelSsh") : t("git.setup.remoteLabel")}
          </label>
          <HelpButton label={t("git.setup.remoteLabel")}>{t("git.setup.remoteHint")}</HelpButton>
        </div>
        <input
          id="git-remote"
          class="settings__text-input"
          type="text"
          placeholder={useSsh() ? t("git.setup.remotePlaceholderSsh") : t("git.setup.remotePlaceholder")}
          value={remote()}
          onInput={(e) => setRemote(e.currentTarget.value)}
        />

        {/* Primary path: username + password. Hidden when signing in with SSH,
            which authenticates with the computer's SSH keys instead. */}
        <Show when={!useSsh()}>
          <label class="settings__label" for="git-username">{t("git.setup.usernameLabel")}</label>
          <input
            id="git-username"
            class="settings__text-input"
            type="text"
            autocomplete="off"
            placeholder={t("git.setup.usernamePlaceholder")}
            value={username()}
            onInput={(e) => setUsername(e.currentTarget.value)}
          />

          <div class="git-panel__label-row">
            <label class="settings__label" for="git-password">{t("git.setup.passwordLabel")}</label>
            <HelpButton label={t("git.setup.passwordLabel")}>{t("git.setup.passwordHint")}</HelpButton>
          </div>
          <input
            id="git-password"
            class="settings__text-input"
            type="password"
            autocomplete="off"
            placeholder={t("git.setup.passwordPlaceholder")}
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </Show>
      </Show>

      <label class="settings__label" for="git-branch">{t("git.setup.branchLabel")}</label>
      <input
        id="git-branch"
        class="settings__text-input"
        type="text"
        value={branch()}
        onInput={(e) => setBranch(e.currentTarget.value)}
      />

      {/* Advanced: SSH instead of username + password (for people who already
          use SSH keys). Tucked below so the simple path leads. */}
      <Show when={!offline()}>
        <div class="git-panel__label-row git-panel__toggle-row">
          <label class="settings__label">{t("git.setup.sshLabel")}</label>
          <HelpButton label={t("git.setup.sshLabel")}>{t("git.setup.sshHint")}</HelpButton>
          <label class="settings__toggle" title={t("git.setup.sshHint")}>
            <input
              type="checkbox"
              checked={useSsh()}
              onChange={(e) => {
                const ssh = e.currentTarget.checked;
                setUseSsh(ssh);
                // Keep the address scheme consistent with the chosen method, so
                // the choice authenticates correctly and survives a reload.
                const r = remote().trim();
                if (r) setRemote(ssh ? toSshRemote(r) : toHttpsRemote(r));
              }}
            />
            <span class="settings__toggle-slider" />
          </label>
        </div>
      </Show>

      <label class="settings__label">{t("git.setup.identityLabel")}</label>
      <div class="git-panel__identity-row">
        <input
          class="settings__text-input"
          type="text"
          placeholder={t("git.setup.namePlaceholder")}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <input
          class="settings__text-input"
          type="text"
          placeholder={t("git.setup.emailPlaceholder")}
          value={email()}
          onInput={(e) => setEmail(e.currentTarget.value)}
        />
      </div>
      <p class="sidebar-hint">{t("git.setup.identityHint")}</p>

      <button
        class="git-panel__primary-btn"
        onClick={submit}
        disabled={busy()}
      >
        {busy()
          ? t("git.setup.submitting")
          : repoMissing()
            ? t("git.setup.reinit")
            : t("git.setup.submit")}
      </button>
    </div>
  );
};

// ─────────────────────────── Sync view ─────────────────────────────────────

const SyncView: Component = () => {
  const cfg = () => noteboxSettings.git;
  // The action + config block (the gestures + the review toggle) is expanded by
  // default so the Sync / Import / Export controls are reachable at a glance.
  // Its open/closed state is a persisted UI preference (see `actionsOpen` in the
  // store) that survives notebox switches and restarts. Same in package and
  // server modes.

  /** Human-readable sync state line. Outgoing state is qualitative ("Changes to
   *  share") rather than a commit count — counts confuse (commits ≠ files) and,
   *  in package mode, never reset since there's no remote to push to. */
  function statusLine(): string {
    const s = gitStatus();
    if (!s) return "";
    if (!s.head && !s.dirty) return t("git.status.unborn");
    const parts: string[] = [];
    if (s.behind > 0) parts.push(t("git.status.behind", { n: s.behind }));
    if (s.unshared) parts.push(t("git.status.toShare"));
    if (parts.length === 0) return t("git.status.synced");
    return parts.join(" · ");
  }

  function statusSynced(): boolean {
    const s = gitStatus();
    return !!s && !!s.head && !s.unshared && s.behind === 0;
  }

  // Package mode = "Import/export changes"; server mode = "Sync changes".
  const sectionTitle = () =>
    packageMode() ? t("git.package.modeLabel") : t("git.sync.heading");

  return (
    <div class="git-panel__body">
      {/* The actions live in a collapsed-by-default section whose header doubles
          as the status row. Merge-first never pauses, so there is no conflict
          resolution view — incoming changes land and are reviewed/reverted from
          the Changes-since-sync list below and the per-note Changes pane. */}
      <div class="git-panel__section">
        <button
          class="git-panel__section-toggle"
          onClick={() => setActionsOpen((v) => !v)}
          aria-expanded={actionsOpen()}
        >
          <span class="git-panel__remote" title={packageMode() ? t("git.package.modeLabel") : cfg()?.remote}>
            <Show when={actionsOpen()} fallback={<ChevronRight size={14} />}>
              <ChevronDown size={14} />
            </Show>
            {sectionTitle()}
          </span>
          <span class="git-panel__status-state">
            <Show when={statusSynced()}><Check size={13} /></Show>
            <Show when={(gitStatus()?.behind ?? 0) > 0}><ArrowDown size={13} /></Show>
            <Show when={gitStatus()?.unshared}><ArrowUp size={13} /></Show>
            {statusLine()}
          </span>
        </button>

        <Show when={actionsOpen()}>
          <div class="git-panel__section-body">
            {/* Package-mode noteboxes have no server, so they Export /
                Import a file instead of Sync / Check. */}
            <Show when={packageMode()} fallback={
              <>
                <div class="git-panel__actions">
                  <button class="git-panel__primary-btn" onClick={() => void sync()} disabled={gitSyncing()}>
                    <RefreshCw size={13} />{" "}
                    <Show when={gitSyncing()} fallback={t("git.actions.sync")}>
                      {t("git.actions.syncingLabel")}
                      <LoadingDots />
                    </Show>
                  </button>
                  <button class="settings__detect-btn" onClick={() => void checkUpdates()} disabled={gitSyncing()}>
                    <DownloadCloud size={13} /> {t("git.actions.checkUpdates")}
                  </button>
                </div>

                {/* A read-only check found incoming changes it did not pull — nudge a Sync. */}
                <Show when={incomingCount() > 0}>
                  <div class="git-panel__banner">
                    <span class="git-panel__banner-author">
                      {tPlural("git.check", incomingCount())}
                    </span>
                    <span class="git-panel__banner-msg">{t("git.check.hint")}</span>
                  </div>
                </Show>
              </>
            }>
              <PackageActions />
            </Show>

            {/* Per-device sharing preference (applies to Sync push and
                package export): vendor the notebox's Typst packages into
                it so they travel and a recipient can compile offline /
                with @local packages. */}
            <div class="git-panel__label-row git-panel__review-toggle">
              <label class="settings__label">{t("git.bundle.toggleLabel")}</label>
              <HelpButton label={t("git.bundle.toggleLabel")}>{t("git.bundle.toggleHint")}</HelpButton>
              <label class="settings__toggle" title={t("git.bundle.toggleHint")}>
                <input
                  type="checkbox"
                  checked={bundlePackages()}
                  onChange={(e) => void setBundlePackages(e.currentTarget.checked)}
                />
                <span class="settings__toggle-slider" />
              </label>
            </div>
          </div>
        </Show>
      </div>

      <ChangesSinceSyncView />
      <UnresolvedView />
      <ChangesToShareView />

      <ManageSection />
    </div>
  );
};

// ─────────────────────────── Package handoff (server-less) ─────────────────

const PackageActions: Component = () => {
  // One optional password, shared by export + import. Empty = no encryption.
  // The recipient must receive it out-of-band; it is never stored in a keychain.
  const [password, setPassword] = createSignal("");
  // Which gesture is running, so only its button shows the animated working
  // state (both share `gitSyncing`, which can't tell them apart). Parity with
  // the server-mode Sync button's "Syncing…" indicator.
  const [busy, setBusy] = createSignal<"import" | "export" | null>(null);

  async function doExport() {
    setBusy("export");
    try {
      await exportPackageInteractive(password());
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    setBusy("import");
    try {
      await importPackageInteractive(password());
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <p class="sidebar-hint">{t("git.package.intro")}</p>

      {/* Password first — it applies to both gestures, so it reads as a setting
          for the buttons below rather than an afterthought. */}
      <div class="git-panel__label-row">
        <label class="settings__label" for="git-pkg-password">{t("git.package.passwordLabel")}</label>
        <HelpButton label={t("git.package.passwordLabel")}>{t("git.package.passwordHint")}</HelpButton>
      </div>
      <input
        id="git-pkg-password"
        class="settings__text-input"
        type="password"
        autocomplete="off"
        value={password()}
        onInput={(e) => setPassword(e.currentTarget.value)}
      />

      <div class="git-panel__actions">
        <button class="git-panel__primary-btn" onClick={() => void doImport()} disabled={gitSyncing()}>
          <FolderDown size={13} />{" "}
          <Show when={busy() === "import"} fallback={t("git.package.importAction")}>
            {t("git.package.importingLabel")}
            <LoadingDots />
          </Show>
        </button>
        <button class="git-panel__primary-btn" onClick={() => void doExport()} disabled={gitSyncing()}>
          <FolderUp size={13} />{" "}
          <Show when={busy() === "export"} fallback={t("git.package.exportAction")}>
            {t("git.package.exportingLabel")}
            <LoadingDots />
          </Show>
        </button>
      </div>
    </>
  );
};

// ─────────── "Changes since last sync" (merge-first incoming review) ────────

/** Lists the notes the last Sync / import folded incoming changes into,
 *  relative to the recorded pre-sync baseline — the merge-first review surface.
 *  The model never pauses, so incoming changes are already in the working tree;
 *  these rows let the user open a note to review the per-hunk diff (in the
 *  Changes pane) or revert the whole note back to their version. Take-theirs
 *  (conflicted) notes are flagged and sort first. Rendered most prominent so
 *  the riskiest incoming changes surface immediately after a sync. */
/** Open a note for review and reveal its Changes pane. Reuses the active tab
 *  only when it's an empty "New tab" — otherwise a new tab, so a note the user is
 *  reading isn't clobbered. An already-open tab for the note is focused either
 *  way (openTab's path-match shortcut). */
function openNoteForReview(path: string, title: string) {
  const reuseEmpty = getActiveTab()?.type === "empty";
  openTab({ type: "file", title, path }, { forceNewTab: !reuseEmpty });
  setRightCollapsed(false);
  setRightPanelTab("annotations");
}

const ChangesSinceSyncView: Component = () => {
  function openForReview(entry: { path: string; relPath: string }) {
    const basename = entry.relPath.split("/").pop() ?? entry.relPath;
    openNoteForReview(entry.path, basename);
  }

  async function revertNote(entry: { path: string; relPath: string; status: string }) {
    const basename = entry.relPath.split("/").pop() ?? entry.relPath;
    // A note the sync *added* has no pre-sync version — reverting deletes it.
    const ok = await promptConfirm({
      title: t("git.sinceSync.revertConfirmTitle"),
      message:
        entry.status === "added"
          ? t("git.sinceSync.revertConfirmBodyAdded", { name: basename })
          : t("git.sinceSync.revertConfirmBody", { name: basename }),
      confirmLabel: t("git.sinceSync.revert"),
    });
    if (ok) void revertNoteSinceSync(entry.path);
  }

  // Author of the changes the most recent sync brought in, when known — folded
  // in here (it used to live in a second, redundant "Changes merged from …"
  // digest block) so there is a single place that reports what a sync changed.
  const incomingAuthor = () => syncOutcome()?.incoming?.author_name;

  return (
    <Show when={changesSinceSync().length > 0}>
      <div class="git-panel__digest git-panel__unresolved">
        <p class="git-panel__share-heading">
          <Show
            when={incomingAuthor()}
            fallback={t("git.sinceSync.heading")}
          >
            {(author) => t("git.sinceSync.headingFrom", { author: author() })}
          </Show>
        </p>
        <p class="sidebar-hint">
          {tPlural("git.sinceSync.count", changesSinceSync().length, {
            n: changesSinceSync().length,
          })}
        </p>
        <div class="git-panel__list">
          <For each={changesSinceSync()}>
            {(entry) => {
              const label = () => changeLabel(entry.relPath, entry.oldRelPath);
              return (
                <div class="sidebar-item git-panel__item" title={entry.relPath}>
                  <button
                    class="git-panel__item-open"
                    title={t("git.sinceSync.reviewHint")}
                    onClick={() => openForReview(entry)}
                  >
                    <span class={`sidebar-item__icon git-panel__icon--${entry.status}`}>
                      {kindIcon(entry.status)}
                    </span>
                    <span class="git-panel__item-body">
                      <span class="sidebar-item__label">{label()}</span>
                      <span class="git-panel__item-meta">
                        <Show when={entry.conflicted}>
                          <span class="git-panel__badge git-panel__badge--conflict">
                            {t("git.sinceSync.tookTheirs")}
                          </span>
                        </Show>
                        <span class="git-panel__badge">{t(`git.digest.status.${entry.status}`)}</span>
                      </span>
                    </span>
                  </button>
                  <button
                    class="annotations-panel__action"
                    title={t("git.sinceSync.revertNote")}
                    aria-label={t("git.sinceSync.revertNote")}
                    onClick={() => void revertNote(entry)}
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
};

// ──────────────── "Changes to resolve" (unresolved tracked changes) ─────────

/** Lists the notebox's notes that still carry unresolved `#suggestion(...)`
 *  tracked changes awaiting an accept/reject decision. Unlike the digest (which
 *  is informational and dismissable) these rows are CLICKABLE and actionable —
 *  clicking opens the real note with the Changes & History pane so the user can
 *  resolve each change. Persistent: reads `unresolvedFiles()` (refreshed on open
 *  / pull / save), independent of the dismissable post-sync digest. Rendered
 *  first in the panel so outstanding work is the most prominent block. */
const UnresolvedView: Component = () => {
  function openForReview(entry: { path: string; relPath: string }) {
    const basename = entry.relPath.split("/").pop() ?? entry.relPath;
    openNoteForReview(entry.path, basename);
  }

  return (
    <Show when={unresolvedFiles().length > 0}>
      <div class="git-panel__digest git-panel__unresolved">
        <p class="git-panel__share-heading">{t("git.unresolved.heading")}</p>
        <p class="sidebar-hint">
          {tPlural("git.unresolved.count", unresolvedFiles().length, {
            n: unresolvedFiles().length,
          })}
        </p>
        <div class="git-panel__list">
          <For each={unresolvedFiles()}>
            {(entry) => {
              const basename = () => entry.relPath.split("/").pop() ?? entry.relPath;
              return (
                <button
                  class="sidebar-item git-panel__item"
                  title={entry.relPath}
                  onClick={() => openForReview(entry)}
                >
                  <span class="sidebar-item__icon git-panel__icon--modified">
                    {kindIcon("modified")}
                  </span>
                  <span class="git-panel__item-body">
                    <span class="sidebar-item__label">{basename()}</span>
                    <span class="git-panel__item-meta">
                      <span class="git-panel__badge">
                        {tPlural("git.unresolved.badge", entry.count, { n: entry.count })}
                      </span>
                    </span>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
};

// ──────────────────── "Changes to share" (what's outgoing) ──────────────────

/** Lists the files an export/sync would carry to collaborators, so the user
 *  sees *what* they're about to share before doing it — the outgoing
 *  counterpart of the post-sync digest. Refetches whenever the git status
 *  changes (saves refresh it), so it tracks the working tree without its own
 *  watcher. Read-only, like the digest. */
const ChangesToShareView: Component = () => {
  // A status fingerprint as the resource source: changes whenever HEAD moves or
  // the dirty/unshared flags flip. Empty (falsy) when there's no status yet, so
  // the resource doesn't fetch.
  const statusKey = () => {
    const s = gitStatus();
    return s ? `${s.head ?? ""}:${s.dirty}:${s.unshared}` : "";
  };
  const [files] = createResource(statusKey, () => gitChangesToShare());

  return (
    <Show when={gitStatus()?.unshared && (files()?.length ?? 0) > 0}>
      <div class="git-panel__digest git-panel__share">
        <p class="git-panel__share-heading">{t("git.share.heading")}</p>
        <p class="sidebar-hint">
          {files()!.length === 1
            ? t("git.digest.oneChange")
            : t("git.digest.changes", { n: files()!.length })}
        </p>
        <div class="git-panel__list">
          <For each={files()}>
            {(entry) => {
              const label = () => changeLabel(entry.path, entry.oldPath);
              return (
                <div
                  class="sidebar-item git-panel__item git-panel__item--readonly"
                  title={entry.path}
                >
                  <span class={`sidebar-item__icon git-panel__icon--${entry.status}`}>
                    {kindIcon(entry.status)}
                  </span>
                  <span class="git-panel__item-body">
                    <span class="sidebar-item__label">{label()}</span>
                    <span class="git-panel__item-meta">
                      <span class="git-panel__badge">{t(`git.digest.status.${entry.status}`)}</span>
                    </span>
                  </span>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
};

// The post-sync "what landed" digest used to live here as a separate block, but
// it duplicated the persistent, actionable "Files changed from last sync" view
// (`ChangesSinceSyncView`) — `run_sync` records the review baseline for every
// incoming sync (fast-forward and merge alike), so that view always reports the
// same changes. The only unique bit, the incoming author, now appears in that
// view's heading. One status surface instead of two.

// ─────────────────────────── Manage (collapsible) ──────────────────────────

const ManageSection: Component = () => {
  // Pre-filled from the current config so every field the setup form had stays
  // editable after setup (remote URL + branch were previously unreachable).
  const [remote, setRemote] = createSignal(noteboxSettings.git?.remote ?? "");
  const [branch, setBranch] = createSignal(noteboxSettings.git?.branch ?? "main");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [name, setName] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [useSsh, setUseSsh] = createSignal(looksLikeSshRemote(noteboxSettings.git?.remote ?? ""));
  // Offline package handoff vs a hosted git server, initialised from the
  // notebox's current mode (an empty remote = package mode). Exposing this in
  // Manage — not only in the initial setup form — lets the user switch
  // collaboration methods after setup, and hides the server connection fields
  // while offline (they don't apply to package handoff).
  const [offline, setOffline] = createSignal(packageMode());

  // Show the identity that will actually be used (per-notebox choice, else git
  // config) and the saved sign-in username, so neither is a mystery blank.
  onMount(async () => {
    const id = await getDefaultIdentity();
    if (id) {
      setName(id.name);
      setEmail(id.email);
    }
    const r = remote().trim();
    if (r) {
      const saved = await gitSavedUsername(r).catch(() => null);
      if (saved) setUsername(saved);
    }
  });

  // One Save applies the whole config — remote/branch/identity/username, plus
  // the password only when re-entered (left blank, the saved one is kept). Both
  // setup paths are idempotent (adopt the existing repo). The Offline toggle
  // chooses the mode: offline switches to (or stays in) package handoff;
  // online keeps (or promotes the notebox to) a server-backed remote.
  async function save() {
    if (!offline() && !remote().trim()) {
      toastError(t("git.manage.saveFailed"), t("git.setup.remoteRequired"));
      return;
    }
    setBusy(true);
    try {
      if (!offline()) {
        await setupCollaboration({
          remote: remote().trim(),
          branch: branch().trim() || "main",
          identityName: name().trim() || undefined,
          identityEmail: email().trim() || undefined,
          username: useSsh() ? undefined : username().trim() || undefined,
          password: useSsh() ? undefined : password().trim() || undefined,
        });
      } else {
        await setupPackageHandoff({
          branch: branch().trim() || "main",
          identityName: name().trim() || undefined,
          identityEmail: email().trim() || undefined,
        });
      }
      setPassword("");
      showToast("success", t("git.manage.saved"));
    } catch (err) {
      toastError(t("git.manage.saveFailed"), err);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    const { confirmed, checked } = await promptConfirmWithCheckbox({
      title: t("git.manage.disable"),
      message: t("git.manage.disableConfirm"),
      confirmLabel: t("git.manage.disable"),
      checkbox: { label: t("git.manage.deleteHistoryOption") },
    });
    if (!confirmed) return;
    try {
      await disableCollaboration(checked);
      showToast("info", checked ? t("git.manage.disabledWithHistory") : t("git.manage.disabled"));
    } catch (err) {
      toastError(t("git.manage.disableFailed"), err);
    }
  }

  return (
    <div class="git-panel__manage">
      <button
        class="git-panel__manage-toggle"
        onClick={() => setManageOpen((v) => !v)}
        aria-expanded={manageOpen()}
      >
        <Show when={manageOpen()} fallback={<ChevronRight size={14} />}>
          <ChevronDown size={14} />
        </Show>
        {t("git.manage.heading")}
      </button>
      <Show when={manageOpen()}>
        <div class="git-panel__manage-body">
          {/* Switch collaboration method. Offline (package handoff) hides the
              server connection fields below — they don't apply with no remote. */}
          <div class="git-panel__label-row git-panel__toggle-row">
            <label class="settings__label">{t("git.setup.offlineLabel")}</label>
            <HelpButton label={t("git.setup.offlineLabel")}>{t("git.setup.offlineHint")}</HelpButton>
            <label class="settings__toggle" title={t("git.setup.offlineHint")}>
              <input
                type="checkbox"
                checked={offline()}
                onChange={(e) => setOffline(e.currentTarget.checked)}
              />
              <span class="settings__toggle-slider" />
            </label>
          </div>

          <Show when={!offline()}>
            <div class="git-panel__label-row">
              <label class="settings__label">
                {useSsh() ? t("git.setup.remoteLabelSsh") : t("git.setup.remoteLabel")}
              </label>
              <HelpButton label={t("git.setup.remoteLabel")}>{t("git.setup.remoteHint")}</HelpButton>
            </div>
            <input
              class="settings__text-input"
              type="text"
              placeholder={useSsh() ? t("git.setup.remotePlaceholderSsh") : t("git.setup.remotePlaceholder")}
              value={remote()}
              onInput={(e) => setRemote(e.currentTarget.value)}
            />

            <Show when={!useSsh()}>
              <label class="settings__label">{t("git.setup.usernameLabel")}</label>
              <input
                class="settings__text-input"
                type="text"
                autocomplete="off"
                placeholder={t("git.setup.usernamePlaceholder")}
                value={username()}
                onInput={(e) => setUsername(e.currentTarget.value)}
              />

              <div class="git-panel__label-row">
                <label class="settings__label">{t("git.setup.passwordLabel")}</label>
                <HelpButton label={t("git.setup.passwordLabel")}>
                  {t("git.setup.passwordHint")} {t("git.manage.passwordKeepHint")}
                </HelpButton>
              </div>
              <input
                class="settings__text-input"
                type="password"
                autocomplete="off"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
              />
            </Show>
          </Show>

          <label class="settings__label">{t("git.setup.branchLabel")}</label>
          <input
            class="settings__text-input"
            type="text"
            value={branch()}
            onInput={(e) => setBranch(e.currentTarget.value)}
          />

          <Show when={!offline()}>
            <div class="git-panel__label-row git-panel__toggle-row">
              <label class="settings__label">{t("git.setup.sshLabel")}</label>
              <HelpButton label={t("git.setup.sshLabel")}>{t("git.setup.sshHint")}</HelpButton>
              <label class="settings__toggle" title={t("git.setup.sshHint")}>
                <input
                  type="checkbox"
                  checked={useSsh()}
                  onChange={(e) => {
                  const ssh = e.currentTarget.checked;
                  setUseSsh(ssh);
                  // Keep the address scheme consistent with the chosen method, so
                  // the choice authenticates correctly and survives a reload.
                  const r = remote().trim();
                  if (r) setRemote(ssh ? toSshRemote(r) : toHttpsRemote(r));
                }}
                />
                <span class="settings__toggle-slider" />
              </label>
            </div>
          </Show>

          <label class="settings__label">{t("git.setup.identityLabel")}</label>
          <div class="git-panel__identity-row">
            <input
              class="settings__text-input"
              type="text"
              placeholder={t("git.setup.namePlaceholder")}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <input
              class="settings__text-input"
              type="text"
              placeholder={t("git.setup.emailPlaceholder")}
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
          </div>
          <p class="sidebar-hint">{t("git.setup.identityHint")}</p>

          <button class="git-panel__primary-btn" onClick={save} disabled={busy()}>
            {busy() ? t("git.manage.saving") : t("git.manage.save")}
          </button>

          <button class="git-panel__danger-btn" onClick={disable}>
            {t("git.manage.disable")}
          </button>
        </div>
      </Show>
    </div>
  );
};

export default GitCollaborationPanel;

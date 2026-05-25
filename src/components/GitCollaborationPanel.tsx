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

import { Component, Show, For, createSignal, onMount } from "solid-js";
import {
  GitBranch,
  Check,
  ArrowUp,
  ArrowDown,
  Pencil,
  Plus,
  Trash2,
  Paperclip,
  AlertTriangle,
  RefreshCw,
  DownloadCloud,
  X,
} from "lucide-solid";
import { noteboxSettings } from "../stores/settings";
import {
  collaborative,
  repoMissing,
  gitStatus,
  syncOutcome,
  syncPaused,
  gitSyncing,
  sync,
  checkUpdates,
  finalizeSync,
  discardReview,
  dismissDigest,
  openStagedNote,
  openDigestEntry,
  refreshStatus,
  setupCollaboration,
  signIn,
  setIdentity,
  getIdentity,
  disableCollaboration,
} from "../stores/git";
import type { GitReviewItem, GitDigestEntry } from "../lib/types";
import { showToast, toastError } from "../stores/toasts";
import { promptConfirm } from "../stores/prompt";
import { t } from "../lib/i18n";

/** Icon for a change kind (mirrors the inline suggestion tones). */
function kindIcon(kind: GitReviewItem["kind"] | GitDigestEntry["status"]) {
  switch (kind) {
    case "added":
      return <Plus size={14} />;
    case "deleted":
      return <Trash2 size={14} />;
    case "binary":
      return <Paperclip size={14} />;
    default:
      return <Pencil size={14} />;
  }
}

const GitCollaborationPanel: Component = () => {
  // Re-check git status whenever the panel opens, so a state change made
  // outside the app (e.g. the `.git` dir deleted) is reflected without a
  // notebox reopen.
  onMount(() => {
    if (collaborative()) void refreshStatus();
  });
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
  const [token, setToken] = createSignal("");
  const [name, setName] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function submit() {
    if (!remote().trim()) {
      toastError(t("git.setup.failed"), t("git.setup.remoteRequired"));
      return;
    }
    setBusy(true);
    try {
      await setupCollaboration({
        remote: remote().trim(),
        branch: branch().trim() || "main",
        identityName: name().trim() || undefined,
        identityEmail: email().trim() || undefined,
        httpsToken: token().trim() || undefined,
      });
      showToast("success", t("git.setup.done"));
    } catch (err) {
      toastError(t("git.setup.failed"), err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="git-panel__body git-panel__setup">
      <Show
        when={repoMissing()}
        fallback={<p class="sidebar-hint">{t("git.setup.intro")}</p>}
      >
        <p class="sidebar-hint git-panel__repair-hint">{t("git.setup.repairHint")}</p>
      </Show>

      <label class="settings__label" for="git-remote">{t("git.setup.remoteLabel")}</label>
      <input
        id="git-remote"
        class="settings__text-input"
        type="text"
        placeholder={t("git.setup.remotePlaceholder")}
        value={remote()}
        onInput={(e) => setRemote(e.currentTarget.value)}
      />

      <label class="settings__label" for="git-branch">{t("git.setup.branchLabel")}</label>
      <input
        id="git-branch"
        class="settings__text-input"
        type="text"
        value={branch()}
        onInput={(e) => setBranch(e.currentTarget.value)}
      />

      <label class="settings__label" for="git-token">{t("git.setup.tokenLabel")}</label>
      <input
        id="git-token"
        class="settings__text-input"
        type="password"
        autocomplete="off"
        value={token()}
        onInput={(e) => setToken(e.currentTarget.value)}
      />
      <p class="sidebar-hint">{t("git.setup.tokenHint")}</p>

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

  /** Human-readable sync state line. */
  function statusLine(): string {
    const s = gitStatus();
    if (!s) return "";
    if (!s.head && !s.dirty) return t("git.status.unborn");
    const parts: string[] = [];
    if (s.behind > 0) parts.push(t("git.status.behind", { n: s.behind }));
    if (s.unpushed > 0) parts.push(t("git.status.ahead", { n: s.unpushed }));
    if (s.dirty) parts.push(t("git.status.dirty"));
    if (parts.length === 0) return t("git.status.synced");
    return parts.join(" · ");
  }

  function statusSynced(): boolean {
    const s = gitStatus();
    return !!s && !!s.head && s.unpushed === 0 && s.behind === 0 && !s.dirty;
  }

  return (
    <div class="git-panel__body">
      {/* Status row */}
      <div class="git-panel__status">
        <span class="git-panel__remote" title={cfg()?.remote}>
          <GitBranch size={13} /> {cfg()?.branch}
        </span>
        <span class="git-panel__status-state">
          <Show when={statusSynced()}><Check size={13} /></Show>
          <Show when={(gitStatus()?.behind ?? 0) > 0}><ArrowDown size={13} /></Show>
          <Show when={(gitStatus()?.unpushed ?? 0) > 0}><ArrowUp size={13} /></Show>
          {statusLine()}
        </span>
      </div>

      {/* The two gestures. Hidden while a conflict resolution is paused — the
          user must finalize or discard that first. */}
      <Show when={!syncPaused()}>
        <div class="git-panel__actions">
          <button class="git-panel__primary-btn" onClick={() => void sync()} disabled={gitSyncing()}>
            <RefreshCw size={13} /> {gitSyncing() ? t("git.actions.syncing") : t("git.actions.sync")}
          </button>
          <button class="settings__detect-btn" onClick={() => void checkUpdates()} disabled={gitSyncing()}>
            <DownloadCloud size={13} /> {t("git.actions.checkUpdates")}
          </button>
        </div>
      </Show>

      <Show when={syncPaused()} fallback={<DigestView />}>
        <ConflictView />
      </Show>

      <ManageSection />
    </div>
  );
};

// ─────────────────────────── Conflicts (paused merge) ──────────────────────

const ConflictView: Component = () => {
  const conflicts = () => syncOutcome()?.conflicts ?? [];
  return (
    <>
      <div class="git-panel__banner git-panel__banner--conflict">
        <span class="git-panel__banner-author">
          <AlertTriangle size={13} /> {t("git.conflict.heading")}
        </span>
        <span class="git-panel__banner-msg">{t("git.conflict.intro")}</span>
      </div>

      <div class="git-panel__list">
        <For each={conflicts()}>
          {(item) => {
            const reviewable = () => item.kind === "modified";
            const basename = () => item.path.split("/").pop() ?? item.path;
            return (
              <div
                class={`sidebar-item git-panel__item${reviewable() ? "" : " git-panel__item--readonly"}`}
                onClick={() => reviewable() && openStagedNote(item)}
                title={item.path}
              >
                <span class={`sidebar-item__icon git-panel__icon--${item.kind}`}>
                  {kindIcon(item.kind)}
                </span>
                <span class="git-panel__item-body">
                  <span class="sidebar-item__label">{basename()}</span>
                  <span class="git-panel__item-meta">
                    <Show
                      when={reviewable()}
                      fallback={<span class="git-panel__badge">{t("git.conflict.binary")}</span>}
                    >
                      <span class="git-panel__badge git-panel__badge--conflict">
                        {item.conflicts === 1
                          ? t("git.review.oneConflict")
                          : t("git.review.conflicts", { n: item.conflicts })}
                      </span>
                    </Show>
                  </span>
                </span>
              </div>
            );
          }}
        </For>
      </div>

      <div class="git-panel__actions">
        <button class="git-panel__primary-btn" onClick={() => void finalizeSync()} disabled={gitSyncing()}>
          <Check size={13} /> {t("git.actions.finalize")}
        </button>
        <button class="settings__detect-btn" onClick={() => void discardReview()} disabled={gitSyncing()}>
          {t("git.actions.discard")}
        </button>
      </div>
    </>
  );
};

// ─────────────────────────── Digest ("what landed") ────────────────────────

const DigestView: Component = () => {
  const outcome = () => syncOutcome();
  const digest = () => outcome()?.digest ?? [];
  // Only show the digest when something actually came in from others.
  return (
    <Show when={outcome() && !outcome()!.upToDate && digest().length > 0}>
      <div class="git-panel__digest">
        <div class="git-panel__digest-head">
          <Show when={outcome()!.incoming}>
            {(incoming) => (
              <span class="git-panel__banner-author">
                {t("git.digest.from", { author: incoming().author_name })}
              </span>
            )}
          </Show>
          <button
            class="git-panel__digest-dismiss"
            title={t("git.digest.dismiss")}
            onClick={dismissDigest}
          >
            <X size={13} />
          </button>
        </div>
        <p class="sidebar-hint">
          {digest().length === 1
            ? t("git.digest.oneChange")
            : t("git.digest.changes", { n: digest().length })}
        </p>
        <div class="git-panel__list">
          <For each={digest()}>
            {(entry) => {
              const basename = () => entry.path.split("/").pop() ?? entry.path;
              const isNote = () => entry.path.endsWith(".typ");
              return (
                <div
                  class={`sidebar-item git-panel__item${isNote() ? "" : " git-panel__item--readonly"}`}
                  onClick={() => isNote() && entry.status !== "deleted" && openDigestEntry(entry.path)}
                  title={entry.path}
                >
                  <span class={`sidebar-item__icon git-panel__icon--${entry.status}`}>
                    {kindIcon(entry.status)}
                  </span>
                  <span class="git-panel__item-body">
                    <span class="sidebar-item__label">{basename()}</span>
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

// ─────────────────────────── Manage (collapsible) ──────────────────────────

const ManageSection: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [token, setToken] = createSignal("");
  const [name, setName] = createSignal("");
  const [email, setEmail] = createSignal("");

  onMount(async () => {
    const id = await getIdentity();
    if (id) {
      setName(id.name);
      setEmail(id.email);
    }
  });

  async function saveToken() {
    try {
      await signIn(token().trim());
      setToken("");
      showToast("success", t("git.manage.signedIn"));
    } catch (err) {
      toastError(t("git.manage.signInFailed"), err);
    }
  }

  async function saveIdentity() {
    try {
      await setIdentity(name().trim(), email().trim());
      showToast("success", t("git.manage.identitySaved"));
    } catch (err) {
      toastError(t("git.manage.identityFailed"), err);
    }
  }

  async function disable() {
    const ok = await promptConfirm({
      title: t("git.manage.disable"),
      message: t("git.manage.disableConfirm"),
      confirmLabel: t("git.manage.disable"),
    });
    if (!ok) return;
    try {
      await disableCollaboration();
      showToast("info", t("git.manage.disabled"));
    } catch (err) {
      toastError(t("git.manage.disableFailed"), err);
    }
  }

  return (
    <div class="git-panel__manage">
      <button
        class="git-panel__manage-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open()}
      >
        {t("git.manage.heading")}
      </button>
      <Show when={open()}>
        <div class="git-panel__manage-body">
          <label class="settings__label">{t("git.manage.signInLabel")}</label>
          <div class="git-panel__inline-form">
            <input
              class="settings__text-input"
              type="password"
              autocomplete="off"
              value={token()}
              onInput={(e) => setToken(e.currentTarget.value)}
            />
            <button class="settings__detect-btn" onClick={saveToken} disabled={!token().trim()}>
              {t("git.manage.signIn")}
            </button>
          </div>

          <label class="settings__label">{t("git.manage.identityLabel")}</label>
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
          <button class="settings__detect-btn" onClick={saveIdentity}>
            {t("git.manage.saveIdentity")}
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

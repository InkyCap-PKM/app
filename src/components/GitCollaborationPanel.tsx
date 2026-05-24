// Left-sidebar Git Collaboration pane (Phase 4 of the notebox-git plan).
//
// Two states, chosen by whether the open notebox carries a git config:
//   • not collaborative → a setup form (remote, branch, sign-in, identity).
//   • collaborative     → status + the fetch→review→consolidate→push loop.
//
// The review surface is intentionally thin here: it lists the incoming changes
// and opens each staged note as a tab, where the existing suggestion pills and
// the right-panel Annotations pane do the actual resolving. "Consolidate"
// writes the resolved staged copy back and commits; "Push" sends it on.

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
} from "lucide-solid";
import { noteboxSettings } from "../stores/settings";
import {
  collaborative,
  repoMissing,
  gitStatus,
  reviewSession,
  gitSyncing,
  fetchReview,
  consolidateNote,
  consolidateAll,
  publish,
  discardReview,
  openStagedNote,
  refreshStatus,
  setupCollaboration,
  signIn,
  setIdentity,
  getIdentity,
  disableCollaboration,
} from "../stores/git";
import type { GitReviewItem } from "../lib/types";
import { showToast, toastError } from "../stores/toasts";
import { promptConfirm } from "../stores/prompt";
import { t } from "../lib/i18n";

/** Icon for a review item's change kind (mirrors the inline suggestion tones). */
const KindIcon: Component<{ item: GitReviewItem }> = (props) => {
  switch (props.item.kind) {
    case "added":
      return <Plus size={14} />;
    case "deleted":
      return <Trash2 size={14} />;
    case "binary":
      return <Paperclip size={14} />;
    default:
      return <Pencil size={14} />;
  }
};

/** Short badge describing what an item carries. */
function itemBadge(item: GitReviewItem): string {
  if (item.kind === "added") return t("git.review.kind.added");
  if (item.kind === "deleted") return t("git.review.kind.deleted");
  if (item.kind === "binary") return t("git.review.kind.binary");
  if (item.fallback) return t("git.review.fallback");
  if (item.total === 0) return t("git.review.clean");
  return item.total === 1
    ? t("git.review.oneSuggestion")
    : t("git.review.suggestions", { n: item.total });
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
        <ReviewView />
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

// ─────────────────────────── Review view ───────────────────────────────────

const ReviewView: Component = () => {
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

  /** There is local work to publish: uncommitted edits or unpushed commits. */
  function hasOutgoing(): boolean {
    const s = gitStatus();
    return !!s && (s.dirty || s.unpushed > 0);
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

      <div class="git-panel__actions">
        <button class="git-panel__primary-btn" onClick={() => void fetchReview()} disabled={gitSyncing()}>
          <RefreshCw size={13} /> {gitSyncing() ? t("git.actions.fetching") : t("git.actions.fetch")}
        </button>
      </div>

      {/* Incoming review list */}
      <Show
        when={reviewSession() && reviewSession()!.items.length > 0}
        fallback={
          <p class="sidebar-hint">
            {reviewSession()?.upToDate ? t("git.review.upToDate") : t("git.review.empty")}
          </p>
        }
      >
        <Show when={reviewSession()!.incoming}>
          {(incoming) => (
            <div class="git-panel__banner">
              <span class="git-panel__banner-author">
                {t("git.review.from", { author: incoming().author_name })}
              </span>
              <span class="git-panel__banner-msg">{incoming().message}</span>
            </div>
          )}
        </Show>

        <div class="git-panel__list">
          <For each={reviewSession()!.items}>
            {(item) => {
              const reviewable = () => item.kind === "modified" || item.kind === "added";
              const basename = () => item.path.split("/").pop() ?? item.path;
              return (
                <div
                  class={`sidebar-item git-panel__item${reviewable() ? "" : " git-panel__item--readonly"}`}
                  onClick={() => reviewable() && openStagedNote(item)}
                  title={item.path}
                >
                  <span class={`sidebar-item__icon git-panel__icon--${item.kind}`}>
                    <KindIcon item={item} />
                  </span>
                  <span class="git-panel__item-body">
                    <span class="sidebar-item__label">{basename()}</span>
                    <span class="git-panel__item-meta">
                      <span class="git-panel__badge">{itemBadge(item)}</span>
                      <Show when={item.conflicts > 0}>
                        <span class="git-panel__badge git-panel__badge--conflict">
                          <AlertTriangle size={11} />
                          {item.conflicts === 1
                            ? t("git.review.oneConflict")
                            : t("git.review.conflicts", { n: item.conflicts })}
                        </span>
                      </Show>
                    </span>
                  </span>
                  <Show when={reviewable()}>
                    <button
                      class="git-panel__item-consolidate"
                      title={t("git.actions.consolidate")}
                      aria-label={t("git.actions.consolidate")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void consolidateNote(item.path);
                      }}
                    >
                      <Check size={14} />
                    </button>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>

        <div class="git-panel__actions">
          <button class="git-panel__primary-btn" onClick={() => void consolidateAll()} disabled={gitSyncing()}>
            {t("git.actions.consolidateAll")}
          </button>
          <button class="settings__detect-btn" onClick={() => void discardReview()} disabled={gitSyncing()}>
            {t("git.actions.discard")}
          </button>
        </div>
      </Show>

      {/* Publish my own work: commit uncommitted edits and/or push commits the
          remote doesn't have yet. Shown whenever there's outgoing work. */}
      <Show when={hasOutgoing()}>
        <div class="git-panel__actions">
          <button class="git-panel__primary-btn" onClick={() => void publish()} disabled={gitSyncing()}>
            <ArrowUp size={13} />{" "}
            {gitStatus()?.dirty
              ? t("git.actions.publish")
              : t("git.actions.pushN", { n: gitStatus()?.unpushed ?? 0 })}
          </button>
        </div>
      </Show>

      <ManageSection />
    </div>
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

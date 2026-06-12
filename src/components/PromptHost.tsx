// Renders the active text-input prompt (if any) as a styled modal.
// Mounted once at the app root; driven by the activePrompt signal in
// stores/prompt.ts. See that file for the call-site contract.

import { Component, Show, For, createSignal, createEffect } from "solid-js";
import { X } from "lucide-solid";
import {
  activePrompt,
  resolvePrompt,
  activeConfirm,
  resolveConfirm,
  activeChoice,
  resolveChoice,
} from "../stores/prompt";
import { useI18n } from "../lib/i18n";

const PromptHost: Component = () => {
  const t = useI18n();
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  // State of the confirm dialog's optional opt-in checkbox. Reset whenever a
  // new confirm opens, to its configured initial value (default off).
  const [confirmChecked, setConfirmChecked] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  // Reset state and focus the input every time a new prompt opens. The
  // initialValue is pre-selected so the user can immediately type to replace.
  createEffect(() => {
    const p = activePrompt();
    if (p) {
      setValue(p.initialValue ?? "");
      setError(null);
      queueMicrotask(() => {
        inputRef?.focus();
        inputRef?.select();
      });
    }
  });

  function submit() {
    const p = activePrompt();
    if (!p) return;
    const v = value().trim();
    if (!v) {
      setError("Please enter a value");
      return;
    }
    const validation = p.validate?.(v);
    if (validation) {
      setError(validation);
      return;
    }
    resolvePrompt(v);
  }

  function cancel() {
    resolvePrompt(null);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  // Reset the checkbox to its initial state each time a confirm opens.
  createEffect(() => {
    const c = activeConfirm();
    if (c) setConfirmChecked(c.checkbox?.initial ?? false);
  });

  function onConfirmKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      resolveConfirm(true, confirmChecked());
    } else if (e.key === "Escape") {
      e.preventDefault();
      resolveConfirm(false);
    }
  }

  function onChoiceKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      resolveChoice(null);
    }
  }

  return (
    <>
    {/* Multi-action chooser — title, message, N action buttons + a header ✕. */}
    <Show when={activeChoice()}>
      {(c) => (
        <div
          class="app-modal__backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) resolveChoice(null);
          }}
          onKeyDown={onChoiceKeyDown}
          tabindex={-1}
          ref={(el) => queueMicrotask(() => el.focus())}
        >
          <div
            class="app-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-choice-title"
          >
            <div class="app-modal__header">
              <h3 id="app-choice-title">{c().title}</h3>
              <button
                class="ui-icon-btn"
                onClick={() => resolveChoice(null)}
                aria-label={t("common.close")}
                title={t("common.close")}
              >
                <X size={16} />
              </button>
            </div>
            <div class="app-modal__body">
              <p class="app-modal__message">{c().message}</p>
            </div>
            <div class="app-modal__footer">
              <For each={c().options}>
                {(opt) => (
                  <button
                    class={`btn btn--${opt.variant ?? "secondary"}`}
                    onClick={() => resolveChoice(opt.id)}
                  >
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      )}
    </Show>

    {/* Yes/no confirmation — same chrome as the text prompt, no input. */}
    <Show when={activeConfirm()}>
      {(c) => (
        <div
          class="app-modal__backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) resolveConfirm(false);
          }}
          onKeyDown={onConfirmKeyDown}
          tabindex={-1}
          ref={(el) => queueMicrotask(() => el.focus())}
        >
          <div
            class="app-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-confirm-title"
          >
            <div class="app-modal__header">
              <h3 id="app-confirm-title">{c().title}</h3>
            </div>
            <div class="app-modal__body">
              <p class="app-modal__message">{c().message}</p>
              <Show when={c().checkbox}>
                {(cb) => (
                  <label class="app-modal__checkbox">
                    <input
                      type="checkbox"
                      checked={confirmChecked()}
                      onChange={(e) => setConfirmChecked(e.currentTarget.checked)}
                    />
                    <span>{cb().label}</span>
                  </label>
                )}
              </Show>
            </div>
            <div class="app-modal__footer">
              <button
                class="btn btn--secondary"
                onClick={() => resolveConfirm(false)}
              >
                {c().cancelLabel ?? "Cancel"}
              </button>
              <button
                class="btn btn--primary"
                onClick={() => resolveConfirm(true, confirmChecked())}
              >
                {c().confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>

    <Show when={activePrompt()}>
      {(p) => (
        <div
          class="app-modal__backdrop"
          onMouseDown={(e) => {
            // Click outside the modal body dismisses. Use mousedown rather
            // than click so the dismissal happens before any focus juggling
            // an input click would trigger.
            if (e.target === e.currentTarget) cancel();
          }}
        >
          <div
            class="app-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-prompt-title"
          >
            <div class="app-modal__header">
              <h3 id="app-prompt-title">{p().title}</h3>
            </div>
            <div class="app-modal__body">
              <Show when={p().label}>
                <label class="app-modal__label" for="app-prompt-input">
                  {p().label}
                </label>
              </Show>
              <input
                id="app-prompt-input"
                ref={inputRef}
                class="app-modal__input"
                type="text"
                value={value()}
                placeholder={p().placeholder ?? ""}
                onInput={(e) => {
                  setValue(e.currentTarget.value);
                  setError(null);
                }}
                onKeyDown={onKeyDown}
              />
              <Show when={p().hint && !error()}>
                <span class="app-modal__hint">{p().hint}</span>
              </Show>
              <Show when={error()}>
                <span class="app-modal__error">{error()}</span>
              </Show>
            </div>
            <div class="app-modal__footer">
              <button
                class="btn btn--secondary"
                onClick={cancel}
              >
                {p().cancelLabel ?? "Cancel"}
              </button>
              <button
                class="btn btn--primary"
                onClick={submit}
              >
                {p().confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
    </>
  );
};

export default PromptHost;

// Renders the active text-input prompt (if any) as a styled modal.
// Mounted once at the app root; driven by the activePrompt signal in
// stores/prompt.ts. See that file for the call-site contract.

import { Component, Show, createSignal, createEffect } from "solid-js";
import {
  activePrompt,
  resolvePrompt,
  activeConfirm,
  resolveConfirm,
} from "../stores/prompt";

const PromptHost: Component = () => {
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
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

  function onConfirmKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      resolveConfirm(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      resolveConfirm(false);
    }
  }

  return (
    <>
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
            </div>
            <div class="app-modal__footer">
              <button
                class="app-modal__btn app-modal__btn--secondary"
                onClick={() => resolveConfirm(false)}
              >
                {c().cancelLabel ?? "Cancel"}
              </button>
              <button
                class="app-modal__btn app-modal__btn--primary"
                onClick={() => resolveConfirm(true)}
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
                class="app-modal__btn app-modal__btn--secondary"
                onClick={cancel}
              >
                {p().cancelLabel ?? "Cancel"}
              </button>
              <button
                class="app-modal__btn app-modal__btn--primary"
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

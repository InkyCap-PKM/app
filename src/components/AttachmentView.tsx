import {
  Component,
  For,
  Match,
  Show,
  Switch,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { ExternalLink } from "lucide-solid";
import * as ipc from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/errors";
import { sanitizeNoteHtml } from "../lib/safe-html";
import { openFileInDefaultApp } from "../lib/open-link";
import { noteboxRelativePath } from "../lib/inkycap-url";
import {
  attachmentViewKind,
  attachmentZooms,
  fetchImageObjectUrl,
  fetchMediaObjectUrl,
} from "../lib/media-src";
import { showAttachmentFileMenu } from "../lib/attachment-nav";
import { noteboxInfo } from "../stores/notebox";
import { tabReadingZoom } from "../stores/tabs";
import { toastError } from "../stores/toasts";
import type { TypstFrame } from "../lib/types";
import PaneNavBar from "./panes/PaneNavBar";
import ReadingZoomControl, { attachReadingZoomWheel } from "./ReadingZoomControl";
import { PT_TO_CSS_PX } from "./TypstEditor";

/**
 * Read-only view of a notebox file that isn't a note: an image, PDF, audio or
 * video file. Images and media load as `blob:` URLs, like embeds in the
 * visual editor; PDF pages are drawn by Typst (see `commands/pdf_view.rs`)
 * and shown with reading mode's page styling, one page at a time as they
 * scroll into view. Images and PDFs zoom with the tab's reading zoom, like
 * a note in reading mode. Right-clicking anywhere shows the attachment's file
 * actions in place of the webview's own menu, whose items (open in a new
 * window, save, …) do nothing in the app. The right panel lists the notes
 * that use the file.
 */
const AttachmentView: Component<{ path: string; tabId: string }> = (props) => {
  const t = useI18n();
  const kind = attachmentViewKind(props.path);

  // The media loaders take the root-absolute form notes use (`/Assets/x.png`).
  const noteboxPath = () => {
    const root = noteboxInfo()?.path;
    const rel = root ? noteboxRelativePath(root, props.path) : null;
    return rel ? `/${rel}` : props.path;
  };

  const openExternally = () =>
    openFileInDefaultApp(props.path).catch((err) =>
      toastError(t("editor.toast.openFailed"), err),
    );

  const cannotShow = (detail?: string) => (
    <div class="attachment-view__message">
      <p>{t("attachmentView.cannotShow")}</p>
      <Show when={detail}>
        <p class="attachment-view__detail">{detail}</p>
      </Show>
      <button type="button" class="btn btn--secondary" onClick={openExternally}>
        {t("attachmentView.openExternally")}
      </button>
    </div>
  );

  const zoom = () => tabReadingZoom(props.tabId);

  return (
    <div
      class="attachment-view"
      onContextMenu={(e) => {
        e.preventDefault();
        showAttachmentFileMenu(e.clientX, e.clientY, props.path, props.tabId);
      }}
    >
      <PaneNavBar
        tabId={props.tabId}
        right={
          <>
            <Show when={attachmentZooms(props.path)}>
              <ReadingZoomControl tabId={props.tabId} />
            </Show>
            <button
            type="button"
            class="editor-header__icon-btn"
            onClick={openExternally}
            title={t("attachmentView.openExternally")}
            aria-label={t("attachmentView.openExternally")}
          >
              <ExternalLink size={14} />
            </button>
          </>
        }
      />
      <Switch fallback={cannotShow()}>
        <Match when={kind === "image"}>
          <ImageView
            source={noteboxPath()}
            tabId={props.tabId}
            zoom={zoom()}
            fallback={cannotShow}
          />
        </Match>
        <Match when={kind === "video" || kind === "audio"}>
          <MediaView
            source={noteboxPath()}
            video={kind === "video"}
            fallback={cannotShow}
          />
        </Match>
        <Match when={kind === "pdf"}>
          <PdfView path={props.path} tabId={props.tabId} zoom={zoom()} fallback={cannotShow} />
        </Match>
      </Switch>
    </div>
  );
};

type Fallback = (detail?: string) => ReturnType<Component>;

/** Load a `blob:` URL for the view's lifetime and release it afterwards. A
 *  failed load leaves the reason in the resource's `error`. */
function useObjectUrl(load: () => Promise<string>) {
  const [url] = createResource(load);
  onCleanup(() => {
    const u = url.error ? undefined : url();
    if (u) URL.revokeObjectURL(u);
  });
  return url;
}

/** An image fitted to the pane at 100% (never enlarged past its own size),
 *  scaled from there by the tab's zoom. */
const ImageView: Component<{
  source: string;
  tabId: string;
  zoom: number;
  fallback: Fallback;
}> = (props) => {
  const url = useObjectUrl(() => fetchImageObjectUrl(props.source));
  const [broken, setBroken] = createSignal(false);
  const [natural, setNatural] = createSignal<{ w: number; h: number }>();
  const [room, setRoom] = createSignal<{ w: number; h: number }>();

  // The space the image can fill: the stage's inner size.
  const measureStage = (stage: HTMLDivElement) => {
    attachReadingZoomWheel(stage, props.tabId);
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(stage);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      setRoom({ w: stage.clientWidth - padX, h: stage.clientHeight - padY });
    });
    observer.observe(stage);
    onCleanup(() => observer.disconnect());
  };

  const size = () => {
    const n = natural();
    const r = room();
    if (!n || !r || n.w === 0 || n.h === 0) return undefined;
    const fit = Math.min(1, r.w / n.w, r.h / n.h);
    return { w: n.w * fit * props.zoom, h: n.h * fit * props.zoom };
  };

  return (
    <Show when={!url.loading} fallback={<Loading />}>
      <Show
        when={!url.error && url() && !broken()}
        fallback={props.fallback(url.error ? errorText(url.error) : undefined)}
      >
        <div class="attachment-view__stage attachment-view__stage--scroll" ref={measureStage}>
          <img
            class="attachment-view__image"
            src={url()!}
            alt={props.source.split("/").pop() ?? ""}
            style={
              size()
                ? { width: `${size()!.w}px`, height: `${size()!.h}px` }
                : { visibility: "hidden" }
            }
            onLoad={(e) =>
              setNatural({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
            onError={() => setBroken(true)}
          />
        </div>
      </Show>
    </Show>
  );
};

/** A video or audio player with the webview's own controls. */
const MediaView: Component<{ source: string; video: boolean; fallback: Fallback }> = (props) => {
  const url = useObjectUrl(() => fetchMediaObjectUrl(props.source));
  const [broken, setBroken] = createSignal(false);
  return (
    <Show when={!url.loading} fallback={<Loading />}>
      <Show
        when={!url.error && url() && !broken()}
        fallback={props.fallback(url.error ? errorText(url.error) : undefined)}
      >
        <div class="attachment-view__stage">
          <Show
            when={props.video}
            fallback={
              <audio
                class="attachment-view__audio"
                src={url()!}
                controls
                onError={() => setBroken(true)}
              />
            }
          >
            <video
              class="attachment-view__video"
              src={url()!}
              controls
              onError={() => setBroken(true)}
            />
          </Show>
        </div>
      </Show>
    </Show>
  );
};

/** Each PDF page is drawn when it comes within a screen of the visible part
 *  of the scroller. Until then it holds the first page's proportions so the
 *  scroll length is about right from the start. */
const PdfView: Component<{
  path: string;
  tabId: string;
  zoom: number;
  fallback: Fallback;
}> = (props) => {
  const t = useI18n();
  const [count] = createResource(() => ipc.getPdfPageCount(props.path));
  const [firstPage] = createResource(
    () => (count() ?? 0) > 0,
    () => ipc.renderPdfPage(props.path, 1),
  );
  const [observer, setObserver] = createSignal<IntersectionObserver>();
  onCleanup(() => observer()?.disconnect());

  // Pages announce themselves to the observer; it tells each one, once, that
  // it is close enough to draw.
  const watchScroller = (el: HTMLDivElement) => {
    attachReadingZoomWheel(el, props.tabId);
    setObserver(
      new IntersectionObserver(
        (entries, obs) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            obs.unobserve(entry.target);
            entry.target.dispatchEvent(new Event(PAGE_NEAR_EVENT));
          }
        },
        { root: el, rootMargin: "100% 0px" },
      ),
    );
  };

  const failure = () => count.error ?? firstPage.error;

  return (
    <Show when={!failure()} fallback={props.fallback(errorText(failure()))}>
      <Show when={count() !== 0} fallback={props.fallback()}>
        <Show when={firstPage()} fallback={<Loading />}>
          {(first) => (
            <div class="typst-reading" ref={watchScroller}>
              <div class="typst-reading__pages">
                <For each={Array.from({ length: count() ?? 0 }, (_, i) => i + 1)}>
                  {(page) => (
                    <PdfPage
                      path={props.path}
                      page={page}
                      initial={page === 1 ? first() : undefined}
                      shape={first()}
                      zoom={props.zoom}
                      observer={observer()}
                    />
                  )}
                </For>
              </div>
            </div>
          )}
        </Show>
      </Show>
    </Show>
  );
};

/** Sent to a page element when it nears the visible part of the scroller. */
const PAGE_NEAR_EVENT = "attachment-view:page-near";

const PdfPage: Component<{
  path: string;
  page: number;
  initial?: TypstFrame;
  shape: TypstFrame;
  zoom: number;
  observer?: IntersectionObserver;
}> = (props) => {
  const t = useI18n();
  const [frame, setFrame] = createSignal<TypstFrame | undefined>(props.initial);
  const [failed, setFailed] = createSignal(false);
  const size = () => frame() ?? props.shape;
  let el: HTMLDivElement | undefined;

  const draw = () => {
    ipc
      .renderPdfPage(props.path, props.page)
      .then(setFrame)
      .catch((err) => {
        console.error("[attachment-view] page failed", props.page, err);
        setFailed(true);
      });
  };

  onMount(() => {
    if (props.initial || !el) return;
    el.addEventListener(PAGE_NEAR_EVENT, draw, { once: true });
    props.observer?.observe(el);
  });

  return (
    <div
      ref={el}
      class="typst-reading__page"
      style={{
        width: `${size().width_pt * PT_TO_CSS_PX * props.zoom}px`,
        height: `${size().height_pt * PT_TO_CSS_PX * props.zoom}px`,
      }}
      role="img"
      aria-label={t("attachmentView.page", { page: props.page })}
    >
      <Show when={frame()}>
        {(f) => (
          <div
            class="attachment-view__page-svg"
            ref={(holder) => {
              const svg = sanitizeNoteHtml(f().svg).querySelector("svg");
              if (svg) holder.replaceChildren(svg);
            }}
          />
        )}
      </Show>
      <Show when={failed()}>
        <div class="typst-reading__status">{t("attachmentView.pageFailed")}</div>
      </Show>
    </div>
  );
};

const Loading: Component = () => {
  const t = useI18n();
  return <div class="typst-reading__status">{t("common.loading")}</div>;
};

export default AttachmentView;

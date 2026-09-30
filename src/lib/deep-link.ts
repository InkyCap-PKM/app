import { createEffect, createRoot } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "./ipc";
import { t } from "./i18n";
import { thisWindowOnly } from "./events";
import { openNoteboxWindow } from "./new-window";
import { pathEquals } from "./paths";
import { promptConfirm } from "../stores/prompt";
import { showToast } from "../stores/toasts";
import { getActiveTab, openTab } from "../stores/tabs";
import { indexReady, isLoading, noteboxInfo, openNotebox } from "../stores/notebox";
import type { DeepLink, DeepLinkDelivery } from "./types";

// Following `inkycap://` links in this window.
//
// The backend (src-tauri/src/deep_link.rs) checks every link and decides which
// window takes it, then sends that window an `app:deep-link` event with the
// checked values; this module acts on it. The main window also receives the
// link InkyCap was started with, through `ipc.deepLinkReady()` at startup (see
// App.tsx). A window opened for a link gets it in its `?link=` parameter.

/** Follow links sent to this window. Call once at startup, in every window;
 *  resolves once the subscription is in place. */
export async function listenForDeepLinks(): Promise<void> {
  await listen<DeepLinkDelivery>(
    "app:deep-link",
    (event) => void followDelivery(event.payload),
    thisWindowOnly(),
  ).catch((err) => console.warn("[deep-link] could not listen for links:", err));
}

/** Act on what the backend asked this window to do with a link. */
export async function followDelivery(delivery: DeepLinkDelivery): Promise<void> {
  switch (delivery.kind) {
    case "open":
      await followInOpenNotebox(delivery.link);
      break;
    case "openNotebox":
      await openNoteboxFor(delivery.link, delivery.ask);
      break;
    case "notFound":
      showToast(
        "info",
        delivery.what === "notebox"
          ? t("deepLink.notFound.notebox", { name: delivery.name })
          : t("deepLink.notFound.note", { name: delivery.name }),
      );
      break;
  }
}

/**
 * Open the link's notebox and follow the link. A window with no notebox open
 * (and none loading) opens it itself when the backend says it need not ask;
 * otherwise the user is asked, and the notebox opens in a new window so this
 * window's tabs are left alone.
 */
async function openNoteboxFor(link: DeepLink, ask: boolean): Promise<void> {
  const root = link.notebox.path;
  if (pathEquals(noteboxInfo()?.path, root)) {
    await followInOpenNotebox(link);
    return;
  }
  if (!ask && noteboxInfo() === null && !isLoading()) {
    const opened = await openNotebox(root).catch((err) => {
      console.warn("[deep-link] could not open the linked notebox:", err);
      return null;
    });
    if (opened) await followInOpenNotebox(link);
    return;
  }
  const confirmed = await promptConfirm({
    title: t("deepLink.openNotebox.title", { name: link.notebox.name }),
    message: t("deepLink.openNotebox.message", { name: link.notebox.name }),
    confirmLabel: t("deepLink.openNotebox.confirm"),
  });
  if (confirmed) openNoteboxWindow(root, link);
}

/** Follow a link whose notebox is open in this window. */
export async function followInOpenNotebox(link: DeepLink): Promise<void> {
  if (link.verb === "search") {
    document.dispatchEvent(
      new CustomEvent("inkycap:open-search", { detail: { query: link.query } }),
    );
    return;
  }
  let path: string;
  if (link.target.kind === "file") {
    path = link.target.path;
  } else {
    // A zid is looked up in this notebox's index, once it has been built.
    await whenIndexReady();
    const found = await ipc.findNoteByZid(link.target.zid).catch(() => null);
    if (!found) {
      showToast("info", t("deepLink.notFound.note", { name: link.target.zid }));
      return;
    }
    path = found;
  }
  const isCollection = path.toLowerCase().endsWith(".collection");
  const title = (path.split("/").pop() ?? path).replace(/\.(typ|collection)$/i, "");
  // Open beside what the user was working on rather than in its place.
  openTab(
    { type: isCollection ? "collection" : "file", title, path },
    {
      forceNewTab: getActiveTab()?.type !== "empty",
      headingLabel: link.heading ?? undefined,
    },
  );
}

/** Resolves once this window's notebox index has finished building. */
function whenIndexReady(): Promise<void> {
  if (indexReady()) return Promise.resolve();
  return new Promise((resolve) => {
    createRoot((dispose) => {
      createEffect(() => {
        if (!indexReady()) return;
        dispose();
        resolve();
      });
    });
  });
}

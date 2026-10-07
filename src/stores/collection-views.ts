// Which view each open collection tab is showing, so the right panel's
// Export and Book tabs work from the same notes the table shows.

import { createStore } from "solid-js/store";

/** What a collection tab's table is showing. */
export interface CollectionViewInfo {
  /** The view's name as the backend takes it; "" means the default view. */
  view: string;
  /** The view's name as shown to the user. */
  label: string;
  /** How many notes the view holds. */
  noteCount: number;
}

// Keyed by tab id rather than collection path: two panes may show the same
// collection in different views.
const [views, setViews] = createStore<Record<string, CollectionViewInfo | undefined>>({});

/** The view the collection tab `tabId` is showing, or undefined before its
 *  table has loaded. Reactive. */
export function collectionViewFor(tabId: string): CollectionViewInfo | undefined {
  return views[tabId];
}

/** Record the view a collection tab's table is showing. Called by the table. */
export function publishCollectionView(tabId: string, info: CollectionViewInfo): void {
  setViews(tabId, { ...info });
}

/** Forget a collection tab's view when its table goes away. */
export function clearCollectionView(tabId: string): void {
  setViews(tabId, undefined);
}

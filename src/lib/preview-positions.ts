// Where the note's source positions appear in a reading view: the measurements
// behind its side of scroll syncing (see scroll-sync.ts).

/** A source position and its distance from the top of the content. */
export interface PreviewAnchor {
  position: number;
  offset: number;
}

/**
 * The longest run of anchors in which position and offset both increase, with
 * the ends of the content added. Content shown out of source order (an outline,
 * footnotes, running headers) drops out.
 */
export function orderedAnchors(anchors: PreviewAnchor[], height: number): PreviewAnchor[] {
  // Equal offsets go highest position first, so a run never holds two of them.
  const sorted = anchors
    .filter((a) => a.position > 1 && a.offset > 0 && a.offset < height)
    .sort((a, b) => a.offset - b.offset || b.position - a.position);

  // Longest increasing subsequence: `tails[n]` is the index of the lowest
  // position that ends a run of length n + 1.
  const tails: number[] = [];
  const previous: number[] = [];
  sorted.forEach((anchor, i) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sorted[tails[mid]].position < anchor.position) low = mid + 1;
      else high = mid;
    }
    previous[i] = low > 0 ? tails[low - 1] : -1;
    tails[low] = i;
  });
  const run: PreviewAnchor[] = [];
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) {
    run.push(sorted[i]);
  }
  run.reverse();

  const lastPosition = run.length > 0 ? run[run.length - 1].position : 1;
  return [
    { position: 1, offset: 0 },
    ...run,
    // The last line runs to the end of the content.
    { position: lastPosition + 1, offset: height },
  ];
}

/** The `to` value matching `value` of `from`, read along the straight line
 *  between neighbouring anchors. `anchors` comes from `orderedAnchors`. */
export function interpolate(
  anchors: PreviewAnchor[],
  from: keyof PreviewAnchor,
  to: keyof PreviewAnchor,
  value: number,
): number {
  let low = 0;
  let high = anchors.length - 1;
  if (value <= anchors[low][from]) return anchors[low][to];
  if (value >= anchors[high][from]) return anchors[high][to];
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (anchors[mid][from] <= value) low = mid;
    else high = mid;
  }
  const a = anchors[low];
  const b = anchors[high];
  return a[to] + ((value - a[from]) / (b[from] - a[from])) * (b[to] - a[to]);
}

/**
 * Anchors of a compiled HTML note, from the positions the backend wrote on its
 * blocks. Offsets are measured as a share of the content's height, because
 * webviews disagree on whether measurements inside a CSS-zoomed element are
 * scaled.
 */
export function htmlAnchors(scroller: HTMLElement, content: HTMLElement): PreviewAnchor[] {
  const above = content.previousElementSibling;
  const contentTop = above
    ? above.getBoundingClientRect().bottom -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop
    : 0;
  const contentRect = content.getBoundingClientRect();
  if (contentRect.height === 0) return [];
  const contentHeight = scroller.scrollHeight - contentTop;
  return Array.from(content.querySelectorAll<HTMLElement>("[data-src-pos]"), (el) => ({
    position: Number(el.dataset.srcPos),
    offset:
      contentTop +
      ((el.getBoundingClientRect().top - contentRect.top) / contentRect.height) * contentHeight,
  })).filter((a) => Number.isFinite(a.position));
}

/**
 * Measured anchors of a reading view, kept until its size changes or
 * `invalidate` is called. `measure` returns the view's unordered anchors.
 */
export function createPreviewMap(scroller: HTMLElement, measure: () => PreviewAnchor[]) {
  let anchors: PreviewAnchor[] = [];
  let measuredSize = "";

  function current(): PreviewAnchor[] {
    const size = `${scroller.scrollHeight}x${scroller.clientWidth}`;
    if (size !== measuredSize) {
      measuredSize = size;
      anchors = orderedAnchors(measure(), scroller.scrollHeight);
    }
    return anchors;
  }

  return {
    invalidate() {
      measuredSize = "";
    },
    /** Null when the view shows nothing from the note. */
    positionAt(offset: number): number | null {
      const list = current();
      return list.length > 2 ? interpolate(list, "offset", "position", offset) : null;
    },
    offsetOf(position: number): number | null {
      const list = current();
      return list.length > 2 ? interpolate(list, "position", "offset", position) : null;
    },
  };
}

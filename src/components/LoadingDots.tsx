import { Component } from "solid-js";

/** Reusable animated "…" — three staggered pulsing dots, sharing the app-wide
 *  `dot-pulse` timing (see `.loading-dots` in styles/layout/search-results.css,
 *  where the animation was first authored). Drop-in for any
 *  in-progress label whose static trailing ellipsis you've removed: render the
 *  text (e.g. "Syncing") and append `<LoadingDots />`. Decorative, so it's
 *  hidden from assistive tech — the surrounding label already conveys state. */
const LoadingDots: Component = () => (
  <span class="loading-dots" aria-hidden="true">
    <span class="loading-dots__dot loading-dots__dot--1">.</span>
    <span class="loading-dots__dot loading-dots__dot--2">.</span>
    <span class="loading-dots__dot loading-dots__dot--3">.</span>
  </span>
);

export default LoadingDots;

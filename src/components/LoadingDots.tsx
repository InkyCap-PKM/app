import { Component } from "solid-js";

/**
 * Animated "…": three pulsing dots with the shared `dot-pulse` timing (see
 * `.loading-dots` in styles/layout/search-results.css). For an in-progress
 * label: write the text without the ellipsis (e.g. "Syncing") and add
 * `<LoadingDots />`. Hidden from screen readers, since the label already says
 * what's happening.
 */
const LoadingDots: Component = () => (
  <span class="loading-dots" aria-hidden="true">
    <span class="loading-dots__dot loading-dots__dot--1">.</span>
    <span class="loading-dots__dot loading-dots__dot--2">.</span>
    <span class="loading-dots__dot loading-dots__dot--3">.</span>
  </span>
);

export default LoadingDots;

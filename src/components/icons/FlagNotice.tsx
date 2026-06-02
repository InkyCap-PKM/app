import type { Component } from "solid-js";
import { lucideFrame } from "./frame";

/**
 * Flag with an alert "!" mark — marks an experimental / not-fully-tested
 * feature. Editable master: `design-assets/flag-notice.svg` — keep the two in
 * sync by hand. Uses `lucideFrame` so it renders as `currentColor` alongside
 * the lucide icons; the flag path keeps its scaled 2.13783 stroke (it was
 * traced at a larger scale in the master), while the "!" inherits the 2px frame
 * stroke.
 */
export const FlagNoticeIcon: Component<{ size?: number; class?: string }> = (
  props,
) => (
  <svg {...lucideFrame(props.size ?? 24)} class={props.class}>
    <path
      stroke-width="2.13783"
      d="M 4.0091375,21.811535 4.0684003,4.3738457 C 4.0696331,4.0111014 4.2153227,3.6695211 4.4649675,3.4518727 5.4946313,2.554179 6.7469921,2.0689133 8.0340719,2.0689133 c 2.9742541,0 4.9570891,2.3049324 7.2700671,2.3049324 1.321891,0 2.335451,-0.3073244 3.040679,-0.921973 0.653578,-0.5698106 1.586269,-0.027711 1.586269,0.921973 V 15.898508 c 0,0.362747 -0.146922,0.704325 -0.396567,0.921973 -1.029664,0.897694 -2.282025,1.382959 -3.569105,1.382959 -2.974254,0 -4.957089,-2.304932 -7.9313431,-2.304932 -1.4632164,4.2e-5 -2.8750876,0.626989 -3.9656716,1.760968"
    />
    <g transform="matrix(0.931095,0,0,0.931095,0.82220453,-0.9340366)">
      <path d="m 12,8 v 4" />
      <path d="m 12,16 h 0.01" />
    </g>
  </svg>
);

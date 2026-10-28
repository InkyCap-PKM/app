import type { JSX, ParentComponent } from "solid-js";
import { Dynamic } from "solid-js/web";
import { CircleAlert, Info } from "lucide-solid";

/** What a notice is telling the reader, which sets its colour and icon. */
export type NoticeTone = "info" | "attention";

const TONE_ICON = {
  info: Info,
  attention: CircleAlert,
} as const;

/**
 * A boxed message that stands out from the text around it: a soft tint, a
 * thin border all round and a leading icon, all in the tone's colour. The icon
 * carries the meaning too, so it doesn't rest on colour alone.
 *
 * - `info`: something to know, e.g. a result or an offer.
 * - `attention`: something waiting on the user, e.g. changes not yet shared.
 *
 * Children are laid out in a column beside the icon. Pass `class` for spacing
 * and `role` (e.g. "status") when the notice appears in response to an action.
 */
const Notice: ParentComponent<{
  tone?: NoticeTone;
  class?: string;
  role?: JSX.HTMLAttributes<HTMLDivElement>["role"];
}> = (props) => (
  <div
    class={`notice notice--${props.tone ?? "info"}`}
    classList={props.class ? { [props.class]: true } : undefined}
    role={props.role}
  >
    <span class="notice__icon" aria-hidden="true">
      <Dynamic component={TONE_ICON[props.tone ?? "info"]} size={14} />
    </span>
    <div class="notice__body">{props.children}</div>
  </div>
);

export default Notice;

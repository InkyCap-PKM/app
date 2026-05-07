import { Component, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { LUCIDE_ICON_MAP } from "./LucideIconPicker";

interface RuleIconProps {
  iconEmoji: string;
  name: string;
  size?: number;
}

const RuleIcon: Component<RuleIconProps> = (props) => {
  const size = () => props.size ?? 16;

  const isLucide = () => props.iconEmoji.startsWith("lucide:");
  const lucideComponent = () => {
    if (!isLucide()) return null;
    const iconName = props.iconEmoji.slice("lucide:".length);
    return LUCIDE_ICON_MAP[iconName] ?? null;
  };

  const displayText = () => {
    if (isLucide()) return null;
    if (props.iconEmoji) return props.iconEmoji;
    return props.name.slice(0, 2);
  };

  return (
    <Show
      when={lucideComponent()}
      fallback={
        <span
          class="rule-icon rule-icon--text"
          style={{ "font-size": `${size()}px`, width: `${size()}px`, height: `${size()}px` }}
        >
          {displayText()}
        </span>
      }
    >
      {(Comp) => (
        <Dynamic component={Comp()} size={size()} class="rule-icon rule-icon--svg" />
      )}
    </Show>
  );
};

export default RuleIcon;

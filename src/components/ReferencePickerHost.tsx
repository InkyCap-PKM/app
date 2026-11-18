// Renders the active reference picker (stores/referencePicker.ts). Mounted once
// at the app root.

import { Component } from "solid-js";
import CitationPicker from "./CitationPicker";
import { activeReferencePicker, resolveReferencePicker } from "../stores/referencePicker";
import { useI18n } from "../lib/i18n";

const ReferencePickerHost: Component = () => {
  const t = useI18n();
  return (
    <CitationPicker
      visible={activeReferencePicker() !== null}
      placeholder={t("literatureNotes.pickReference")}
      onSelect={(entry) => resolveReferencePicker(entry)}
      onClose={() => resolveReferencePicker(null)}
    />
  );
};

export default ReferencePickerHost;

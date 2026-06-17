// A one-shot channel for activating a saved Agenda-view bookmark.
//
// Activating a view has to survive the Agenda panel being mounted *as part of*
// the activation (clicking the bookmark switches the sidebar to Agenda mode,
// which mounts the panel fresh). A plain prop or DOM event would be missed by a
// listener that registers only after the switch; a module-level signal instead
// holds the request until the panel reads and clears it, regardless of timing.

import { createSignal } from "solid-js";
import type { AgendaFilterSnapshot } from "../components/AgendaList";

const [requestedAgendaView, setRequestedAgendaView] =
  createSignal<AgendaFilterSnapshot | null>(null);

export { requestedAgendaView, setRequestedAgendaView };

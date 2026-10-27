// One-time request to activate a saved Agenda view bookmark. Clicking the
// bookmark switches the sidebar to Agenda, which mounts the panel, so a prop or
// DOM event would arrive before the panel listens. A module-level signal keeps
// the request until the panel reads and clears it.

import { createSignal } from "solid-js";
import type { AgendaFilterSnapshot } from "../components/AgendaList";

const [requestedAgendaView, setRequestedAgendaView] =
  createSignal<AgendaFilterSnapshot | null>(null);

export { requestedAgendaView, setRequestedAgendaView };

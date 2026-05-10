import { render } from "solid-js/web";
import "katex/dist/katex.min.css";
import App from "./App";

// Native OS file drops are handled by Tauri's own drag-drop event
// listener (see src/lib/tauri-drag-drop.ts, attached from App.tsx).
// Tauri intercepts the drop at the native layer — the webview
// never sees it — so no window-level JS preventDefault is needed
// to stop the default "navigate to file://" behavior.

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

render(() => <App />, root);

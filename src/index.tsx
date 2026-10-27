import { render } from "solid-js/web";
import "./styles/bundled-fonts.css";
import App from "./App";

// Native file drops are handled by Tauri's drag-drop listener
// (src/lib/tauri-drag-drop.ts, attached in App.tsx). Tauri takes the drop
// before the webview sees it, so no preventDefault is needed here to stop
// "navigate to file://".

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

render(() => <App />, root);

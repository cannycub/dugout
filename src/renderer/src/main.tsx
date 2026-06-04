import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles.css";

import { App } from "./App.js";
import { DugoutProvider } from "./dugout-context.js";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// The injected IPC implementation; swappable for an HTTP client behind the same interface.
createRoot(root).render(
  <StrictMode>
    <DugoutProvider api={window.dugout}>
      <App />
    </DugoutProvider>
  </StrictMode>,
);

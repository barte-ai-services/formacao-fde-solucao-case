import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "barte-design-system/styles";
import "@barte-ai-services/barte-ui-kit/styles";
import "@barte-ai-services/shell-kit/styles.css";
import { ToastProvider } from "barte-design-system";
import { App } from "./App";
import "./evidence";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);

import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./query-client";
import { startTheme } from "./lib/theme";
import { WorkspaceRoot } from "./WorkspaceRoot";
import "@fontsource-variable/inter";
import "./styles.css";

startTheme();

const queryClient = createQueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WorkspaceRoot />
    </QueryClientProvider>
  </StrictMode>,
);

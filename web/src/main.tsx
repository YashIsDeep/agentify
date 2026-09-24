import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./query-client";
import { startTheme } from "./lib/theme";
import "@fontsource-variable/inter";
import { TooltipProvider } from "./ui";
import { WorkspaceRoot } from "./WorkspaceRoot";
import "./styles.css";

startTheme();

const queryClient = createQueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WorkspaceRoot />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);

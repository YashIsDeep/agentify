import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./query-client";
import { fillInsecureContextGaps } from "./lib/insecure-context";
import { startTheme } from "./lib/theme";
import "@fontsource-variable/inter";
import { SessionGate } from "./SessionGate";
import { TooltipProvider } from "./ui";
import { WorkspaceRoot } from "./WorkspaceRoot";
import "./styles.css";

fillInsecureContextGaps();
startTheme();

const queryClient = createQueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SessionGate>
          <WorkspaceRoot />
        </SessionGate>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);

import { z } from "zod";
import { resolveInside } from "../paths";
import type { ActionDefinition } from "./types";
import { artifactName } from "./validation";
import { artifactHistory } from "../services/artifact-history";

const configSchema = z.object({
  name: artifactName("File name"),
  content: z.string(),
});

export const writeArtifactAction: ActionDefinition<z.output<typeof configSchema>> = {
  type: "write-artifact",
  label: "Write artifact",
  description: "Writes templated content to a file in the task's artifacts folder.",
  configSchema,
  fields: [
    { name: "name", label: "File name", kind: "text", default: "", templated: true, placeholder: "notes.md" },
    { name: "content", label: "Content", kind: "textarea", default: "", templated: true },
  ],
  async run({ config, artifactDir, log }) {
    const path = resolveInside(artifactDir, config.name);
    const history = artifactHistory(artifactDir, config.name);
    history.build(config.content);
    history.publish(config.content);
    log(`Wrote ${config.name}`);
    return { outputs: { name: config.name, path }, summary: `wrote ${config.name}` };
  },
};

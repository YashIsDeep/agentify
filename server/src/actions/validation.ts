import { z } from "zod";

/**
 * Config values are Mustache-rendered just before a run, so a field holding `{{task.title}}.md`
 * can only be checked once its value is known. Anything with a tag in it is left to the run;
 * everything else is checked when the workflow is saved, which is where a typo is cheap to fix.
 */
export const isTemplated = (value: string): boolean => value.includes("{{");

/** A path inside the task's artifact directory: no absolute paths, no escaping upwards. */
export const artifactName = (label: string) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => isTemplated(value) || !/^([a-zA-Z]:[\\/]|[\\/])/.test(value),
      `${label} must be relative to the task's artifacts folder, not an absolute path`,
    )
    .refine(
      (value) => isTemplated(value) || !value.split(/[\\/]/).includes(".."),
      `${label} cannot contain ".."`,
    );

/** Output name → regex. A regex that doesn't compile used to fail only when the command ran. */
export const extractPatterns = z
  .record(z.string(), z.string())
  .default({})
  .superRefine((patterns, ctx) => {
    for (const [name, pattern] of Object.entries(patterns)) {
      if (isTemplated(pattern)) continue;
      try {
        new RegExp(pattern, "m");
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          message: `the regex for output “${name}” is invalid: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  });

/** Rejects a shape the service will certainly refuse, without pretending to know it exists. */
export const remoteId = (label: string, pattern: RegExp, example: string) =>
  z
    .string()
    .default("")
    .refine(
      (value) => !value.trim() || isTemplated(value) || pattern.test(value),
      `${label} should look like ${example}`,
    );

import { describeGenerated, within } from "./development.mjs";
export async function enrichFindings(findings) {
  const managed = findings
    .filter((f) => ["builds", "dependencies"].includes(f.category))
    .map((f) => f.path);
  return Promise.all(
    findings.map(async (finding) => {
      const f = { ...finding };
      if (
        f.category === "duplicates" &&
        managed.some((root) => within(f.path, root))
      ) {
        f.insight = {
          reason:
            "These identical copies are inside package-managed or generated folders. Different paths may both be required.",
          restore:
            "Keep individual package files. Review the complete dependency or build folder instead.",
        };
      } else if (f.category === "large" && /\.(dll|dylib|so)$/i.test(f.path)) {
        f.insight = {
          reason:
            "This is an application library. An old modification date does not establish that the tool is unused.",
          restore:
            "Review or uninstall the owning application rather than deleting this component.",
        };
      } else if (["builds", "dependencies"].includes(f.category)) {
        try {
          const evidence = await describeGenerated(f.path);
          f.insight = evidence
            ? {
                reason: evidence.reason,
                restore: evidence.restore,
                projectPath: evidence.projectPath,
              }
            : {
                reason:
                  "Current project evidence does not establish a supported cleanup action for this folder.",
                restore:
                  "Inspect the project and its installation/build instructions. A fresh deletion preview will explain any blockers.",
              };
        } catch (e) {
          f.insight = {
            reason: "Current project evidence could not be inspected.",
            restore: e.message,
          };
        }
      } else if (f.category === "caches") {
        f.insight = {
          reason:
            "A cache-like name alone does not prove its contents are disposable.",
          restore:
            "Close the owner and use its documented cache-cleaning operation. Generic caches are review-only.",
        };
      }
      return f;
    }),
  );
}

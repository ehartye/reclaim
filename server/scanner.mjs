import path from "node:path";
import { homedir } from "node:os";
import { scanFolderSizes } from "./folder-scan.mjs";

export const defaults = {
  exclusions: [],
  skipCloud: true,
  developmentRoots: [path.join(homedir(), "repos")],
};

export async function scan(
  input,
  { signal, onProgress = () => {}, folderCache = [] } = {},
) {
  if (input.operation !== undefined && input.operation !== "folder-sizes")
    throw new Error("Only the folder-sizes scan operation is supported.");
  return scanFolderSizes(
    { ...defaults, ...input, operation: "folder-sizes" },
    { signal, onProgress, folderCache },
  );
}

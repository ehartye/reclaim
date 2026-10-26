import { lstat } from "node:fs/promises";
import path from "node:path";
export async function probeActivity(target) {
  const evidence = [],
    times = [];
  const add = async (p, label) => {
    const st = await lstat(p);
    if (st.isSymbolicLink())
      throw new Error("A filesystem link needs fresh safety inspection.");
    times.push(st.mtimeMs, st.birthtimeMs);
    evidence.push(label);
    return st;
  };
  try {
    const root = await add(
      target.path,
      "Folder creation and last-write times (fast hint only)",
    );
    if (!root.isDirectory())
      throw new Error("The target is no longer a directory.");
    if (target.category === "dependencies")
      for (const marker of [
        ".package-lock.json",
        ".modules.yaml",
        ".yarn-state.yml",
        "pyvenv.cfg",
      ])
        try {
          await add(
            path.join(target.path, marker),
            "Install/environment marker: " + marker,
          );
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
    const known = times.filter((t) => Number.isFinite(t) && t > 0);
    return {
      latestAt: known.length ? Math.max(...known) : null,
      checkedAt: new Date().toISOString(),
      evidence,
      complete: false,
    };
  } catch (e) {
    return {
      latestAt: null,
      checkedAt: new Date().toISOString(),
      evidence,
      complete: false,
      error: e.message,
    };
  }
}

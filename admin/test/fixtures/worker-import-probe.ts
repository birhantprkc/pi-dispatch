// Proves jiti resolves the @pi-dispatch/worker workspace symlink and its
// exports map (the real 3.2 risk), not just bare-relative TypeScript.
import { settingsFilePath } from "@pi-dispatch/worker/runtime-settings";

export const ok = typeof settingsFilePath === "function";

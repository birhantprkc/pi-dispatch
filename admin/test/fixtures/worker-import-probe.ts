// Proves jiti resolves the @edgehero/pi-dispatch workspace symlink and its
// exports map (the real 3.2 risk), not just bare-relative TypeScript.
import { settingsFilePath } from "@edgehero/pi-dispatch/runtime-settings";

export const ok = typeof settingsFilePath === "function";

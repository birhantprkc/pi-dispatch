// pi-dispatch admin extension shim.
//
// pi loads this only after the operator trusts this checkout (docs/extensions.md
// trust gating). A job container DOES now discover a serviced repo's
// .pi/extensions -- including this file, when pi-dispatch services its own repo --
// so the runner's recursion guard drops it (image/runner/src/loader.mjs,
// dropAdminExtensions) and the admin surface never reaches the job's session
// (INT-SDK-SESSION-OPTIONS, REQ-ADMIN-VIA-PI-EXTENSION Scope).
export { USED_API, SUPPORTED_PI_VERSION } from "../../admin/src/index.ts";
export { default } from "../../admin/src/index.ts";

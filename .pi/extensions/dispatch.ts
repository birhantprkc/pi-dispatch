// pi-dispatch admin extension shim.
//
// pi loads this only after the operator trusts this checkout (docs/extensions.md
// trust gating). A job container can never load it: the job loader sets
// noExtensions:true and mounts only the serviced repo's /job/pi
// (INT-SDK-SESSION-OPTIONS, REQ-ADMIN-VIA-PI-EXTENSION Scope).
export { USED_API, SUPPORTED_PI_VERSION } from "../../admin/src/index.ts";
export { default } from "../../admin/src/index.ts";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiAttention } from "./runtime.js";
import { registerPiBridge } from "./bridge.js";
import { registerPiOrders } from "./orders.js";

// Load this file in place: sibling modules are part of the extension.
export default function (pi: ExtensionAPI) {
  registerPiAttention(pi);
  registerPiBridge(pi);
  registerPiOrders(pi);
}

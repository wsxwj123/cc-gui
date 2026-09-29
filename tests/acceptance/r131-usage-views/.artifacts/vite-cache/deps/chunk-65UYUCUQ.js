import {
  getConfig2
} from "./chunk-O722XQWF.js";
import {
  __name,
  select_default
} from "./chunk-WIE5KO3R.js";

// ../../../../client/node_modules/mermaid/dist/chunks/mermaid.core/chunk-WU5MYG2G.mjs
var selectSvgElement = __name((id) => {
  var _a;
  const { securityLevel } = getConfig2();
  let root = select_default("body");
  if (securityLevel === "sandbox") {
    const sandboxElement = select_default(`#i${id}`);
    const doc = ((_a = sandboxElement.node()) == null ? void 0 : _a.contentDocument) ?? document;
    root = select_default(doc.body);
  }
  const svg = root.select(`#${id}`);
  return svg;
}, "selectSvgElement");

export {
  selectSvgElement
};
//# sourceMappingURL=chunk-65UYUCUQ.js.map

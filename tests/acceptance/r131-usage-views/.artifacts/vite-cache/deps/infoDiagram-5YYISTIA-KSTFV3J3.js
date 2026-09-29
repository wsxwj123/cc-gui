import {
  parse
} from "./chunk-RX7NKTUU.js";
import "./chunk-TC36VOXN.js";
import "./chunk-PKEQIUFZ.js";
import "./chunk-XRWODRY5.js";
import "./chunk-YW2ANOYA.js";
import "./chunk-XXCRMBWM.js";
import "./chunk-TD5OEI4F.js";
import "./chunk-RUEBSE65.js";
import "./chunk-2ACV6NBF.js";
import "./chunk-W7BJFXDR.js";
import "./chunk-SPLR7M4U.js";
import "./chunk-HKW4PMTF.js";
import {
  selectSvgElement
} from "./chunk-65UYUCUQ.js";
import {
  configureSvgSize
} from "./chunk-O722XQWF.js";
import {
  __name,
  log
} from "./chunk-WIE5KO3R.js";
import "./chunk-DC5AMYBS.js";

// ../../../../client/node_modules/mermaid/dist/chunks/mermaid.core/infoDiagram-5YYISTIA.mjs
var parser = {
  parse: __name(async (input) => {
    const ast = await parse("info", input);
    log.debug(ast);
  }, "parse")
};
var DEFAULT_INFO_DB = {
  version: "11.15.0" + (true ? "" : "-tiny")
};
var getVersion = __name(() => DEFAULT_INFO_DB.version, "getVersion");
var db = {
  getVersion
};
var draw = __name((text, id, version) => {
  log.debug("rendering info diagram\n" + text);
  const svg = selectSvgElement(id);
  configureSvgSize(svg, 100, 400, true);
  const group = svg.append("g");
  group.append("text").attr("x", 100).attr("y", 40).attr("class", "version").attr("font-size", 32).style("text-anchor", "middle").text(`v${version}`);
}, "draw");
var renderer = { draw };
var diagram = {
  parser,
  db,
  renderer
};
export {
  diagram
};
//# sourceMappingURL=infoDiagram-5YYISTIA-KSTFV3J3.js.map

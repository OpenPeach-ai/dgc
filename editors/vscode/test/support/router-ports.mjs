// The ports DGC Router's Look on my network checks, as the backend lists them (dgc/router_probe.py: MODEL_PORTS, then
// KNOWN_PORTS = MODEL_PORTS + the image servers' ports), joined as the cards and Settings say them: "11434, 8080, ...".
import { readFileSync } from "node:fs";

export function knownPorts() {
  const source = readFileSync(new URL("../../../../dgc/router_probe.py", import.meta.url), "utf8");
  const tuple = (text) => text.split(",").map((part) => part.trim()).filter(Boolean);
  const model = source.match(/^MODEL_PORTS = \(([^)]*)\)/m);
  const known = source.match(/^KNOWN_PORTS = MODEL_PORTS \+ \(([^)]*)\)/m);
  if (!model || !known) throw new Error("dgc/router_probe.py no longer has MODEL_PORTS and KNOWN_PORTS as this reads them");
  return [...tuple(model[1]), ...tuple(known[1])].join(", ");
}

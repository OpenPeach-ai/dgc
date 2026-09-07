// Keep the QA server and response checks aligned without taking over an existing local service.
const configuredPort = process.env.DGC_SITE_QA_PORT || "4173";
if (!/^\d{1,5}$/.test(configuredPort) || Number(configuredPort) < 1024 || Number(configuredPort) > 65535) {
  throw new Error("DGC_SITE_QA_PORT must be an integer from 1024 through 65535");
}
export const QA_PORT = Number(configuredPort);
export const QA_ORIGIN = `http://127.0.0.1:${QA_PORT}`;

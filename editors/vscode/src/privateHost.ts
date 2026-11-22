// An address no public site has, by how it is written: an IP address, localhost, a one-word name, a private or tailnet
// name. One rule for the two places that must not send such an address anywhere: a link's site icon (src/markdown.ts)
// and a link's preview card (src/linkPreview.ts, which also tells a public IP address from a private one and checks
// what a name resolves to).
export const PRIVATE_HOST = /^(?:localhost|[^.]+|\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$|\.(?:localhost|local|lan|home|internal|intranet|corp|private|home\.arpa|ts\.net)$/i;

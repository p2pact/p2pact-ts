// Binary assets the browser bundle embeds (scripts/build-browser.mjs loads them as bytes).
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}
declare module "*.zdict" {
  const bytes: Uint8Array;
  export default bytes;
}

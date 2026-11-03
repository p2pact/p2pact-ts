// Builds the browser bundle: dist/browser/p2pact.js (ESM, minified; the common dictionary and the
// zstd decoder wasm are embedded). node scripts/build-browser.mjs [--report]
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// zstd-wasm-decoder's default entry carries its own inlined wasm; the codec makes decoders from the
// bytes it is given, so only the decoder class is taken. The Node.js flavour of the node is never
// part of a browser bundle (P2pactClient.open needs it: it throws there).
const plugin = {
  name: "p2pact-browser",
  setup(b) {
    b.onResolve({ filter: /^zstd-wasm-decoder$/ }, () => ({ path: path.join(root, "node_modules/zstd-wasm-decoder/_esm/zstd-wasm.js") }));
    b.onResolve({ filter: /node-fs\.js$/ }, () => ({ path: "node-fs-stub", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `export class Node { constructor() { throw new Error("P2pactClient.open is for Node.js: in a browser use createBrowserNode and P2pactClient.wrap"); } }`,
      loader: "js",
    }));
  },
};

export async function buildBrowser(outfile = path.join(root, "dist/browser/p2pact.js")) {
  await build({
    entryPoints: [path.join(root, "src/browser.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    loader: { ".zdict": "binary", ".wasm": "binary" },
    plugins: [plugin],
    logLevel: "warning",
  });
  return outfile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await buildBrowser();
  const buf = readFileSync(out);
  console.log(`${path.relative(root, out)}: ${buf.length} bytes, ${gzipSync(buf).length} gzip`);
}

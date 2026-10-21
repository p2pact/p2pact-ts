// The common dictionary (spec §5, dict/common-1.zdict of the spec repository): trained on open
// conversations, the same for everyone.
import * as fs from "node:fs";

/** commonDict compresses until a device has trained its own for a device: node.addDict(commonDict). */
export const commonDict: Uint8Array = new Uint8Array(fs.readFileSync(new URL("../../dict/common-1.zdict", import.meta.url)));

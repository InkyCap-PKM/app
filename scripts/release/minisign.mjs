// Checks a Tauri updater signature against the public key in tauri.conf.json,
// the same way the updater plugin inside the app will. Run after signing so a
// release signed with the wrong key (for example a stale key file on one of
// several computers) is caught before users' Upgrade buttons reject it.
//
// Formats (minisign, wrapped by Tauri in one extra layer of base64):
//   public key: base64 of "untrusted comment: …\n<base64 of: 'Ed' + key id (8) + key (32)>"
//   signature:  base64 of "untrusted comment: …\n<base64 of: alg (2) + key id (8) + sig (64)>\n
//               trusted comment: …\n<base64 of: global sig (64)>"
// alg "ED" means the signature covers the BLAKE2b-512 hash of the file; "Ed"
// means it covers the file itself. The global signature covers the file
// signature followed by the trusted comment text.

import { createHash, createPublicKey, verify } from "node:crypto";

const TRUSTED_PREFIX = "trusted comment: ";

/** Undo Tauri's outer base64 and return the non-empty lines. */
function unwrap(tauriBase64) {
  return Buffer.from(tauriBase64.trim(), "base64").toString("utf8").split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

/**
 * Parse the `plugins.updater.pubkey` value from tauri.conf.json.
 * Throws with a plain explanation when the value isn't a minisign public key.
 */
export function parsePublicKey(tauriPubkey) {
  const lines = unwrap(tauriPubkey);
  const raw = lines[1] ? Buffer.from(lines[1], "base64") : Buffer.alloc(0);
  if (!lines[0]?.startsWith("untrusted comment:") || raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") {
    throw new Error("the updater public key in tauri.conf.json is not a valid Tauri/minisign public key");
  }
  const keyId = raw.subarray(2, 10);
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10).toString("base64url") },
    format: "jwk",
  });
  return { keyId, key };
}

/** Readable form of a key id, as minisign prints it. */
export const keyIdHex = (keyId) => Buffer.from(keyId).reverse().toString("hex").toUpperCase();

/**
 * Check `tauriSig` (the contents of a `.sig` file) against `fileBytes`.
 * Returns `{ ok: true, signedVersion }` or `{ ok: false, reason }`.
 * `signedVersion` is the `version:` field newer Tauri CLIs record in the
 * trusted comment (null when absent); the updater plugin refuses an update
 * whose feed announces a different version than the one signed.
 */
export function verifySignature(fileBytes, tauriSig, publicKey) {
  const lines = unwrap(tauriSig);
  if (lines.length < 4 || !lines[2].startsWith(TRUSTED_PREFIX)) {
    return { ok: false, reason: "the .sig file is not in the expected format" };
  }
  const sigBox = Buffer.from(lines[1], "base64");
  if (sigBox.length !== 74) return { ok: false, reason: "the .sig file is not in the expected format" };

  const alg = sigBox.subarray(0, 2).toString();
  const keyId = sigBox.subarray(2, 10);
  const signature = sigBox.subarray(10);
  if (!keyId.equals(publicKey.keyId)) {
    return {
      ok: false,
      reason: `signed with key ${keyIdHex(keyId)}, but tauri.conf.json holds the public key for ${keyIdHex(publicKey.keyId)}`,
    };
  }

  let message;
  if (alg === "ED") message = createHash("blake2b512").update(fileBytes).digest();
  else if (alg === "Ed") message = fileBytes;
  else return { ok: false, reason: `unknown signature type "${alg}"` };
  if (!verify(null, message, publicKey.key, signature)) {
    return { ok: false, reason: "the signature does not match this file" };
  }

  const trusted = Buffer.from(lines[2].slice(TRUSTED_PREFIX.length), "utf8");
  const globalSig = Buffer.from(lines[3], "base64");
  if (!verify(null, Buffer.concat([signature, trusted]), publicKey.key, globalSig)) {
    return { ok: false, reason: "the signature's trusted comment has been altered" };
  }
  const field = trusted.toString("utf8").split("\t").find((f) => f.startsWith("version:"));
  return { ok: true, signedVersion: field ? field.slice("version:".length) : null };
}

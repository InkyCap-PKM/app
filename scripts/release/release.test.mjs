// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACTS, channelOf } from "./config.mjs";
import { buildLatestFeed, buildUpdaterFeed, findArtifacts, updaterChannelsFor } from "./feeds.mjs";
import { parsePublicKey, verifySignature } from "./minisign.mjs";

const wrap = (text) => Buffer.from(text).toString("base64");

/** A key pair in Tauri's wrapped minisign format, with a signer for files. */
function makeKey(keyIdByte) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.alloc(8, keyIdByte);
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const pubkey = wrap(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawPub]).toString("base64")}\n`);
  const signFile = (bytes, version) => {
    const sig = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
    const trusted = `timestamp:1\tfile:test.deb${version ? `\tversion:${version}` : ""}`;
    const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
    return wrap(
      `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64")}\n` +
        `trusted comment: ${trusted}\n${global.toString("base64")}\n`,
    );
  };
  return { pubkey, signFile };
}

describe("minisign signature check", () => {
  const file = Buffer.from("installer bytes");
  const key = makeKey(1);

  it("accepts a signature made by the matching key", () => {
    expect(verifySignature(file, key.signFile(file), parsePublicKey(key.pubkey))).toEqual({ ok: true, signedVersion: null });
  });

  it("reads the version newer Tauri CLIs record in the signature", () => {
    const res = verifySignature(file, key.signFile(file, "26.10.2"), parsePublicKey(key.pubkey));
    expect(res).toEqual({ ok: true, signedVersion: "26.10.2" });
  });

  it("rejects a file that differs from the one signed", () => {
    const res = verifySignature(Buffer.from("other bytes"), key.signFile(file), parsePublicKey(key.pubkey));
    expect(res.ok).toBe(false);
  });

  it("names the key mismatch when signed with a different key", () => {
    const res = verifySignature(file, makeKey(2).signFile(file), parsePublicKey(key.pubkey));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/signed with key/);
  });

  it("rejects a public key that isn't one", () => {
    expect(() => parsePublicKey(wrap("hello"))).toThrow(/not a valid/);
  });
});

describe("release feeds", () => {
  it("picks the channel from the last component's parity", () => {
    expect(channelOf("26.10.2")).toBe("stable");
    expect(channelOf("26.10.1")).toBe("beta");
  });

  it("keeps the other channel when updating latest.json", () => {
    const base = { schema: 1, channels: { stable: { version: "26.10.2" } } };
    const feed = buildLatestFeed(base, { version: "26.10.3", channel: "beta", notes: "n", date: "2026-10-20" });
    expect(feed.schema).toBe(1);
    expect(feed.channels.stable.version).toBe("26.10.2");
    expect(feed.channels.beta).toMatchObject({ version: "26.10.3", notes: "n" });
    expect(feed.channels.beta.url).toContain("/tag/v26.10.3");
  });

  it("lists each installer under every platform key it answers to", () => {
    const mac = ARTIFACTS.find((a) => a.platforms.includes("darwin-aarch64-app"));
    const deb = ARTIFACTS.find((a) => a.platforms.includes("linux-x86_64-deb"));
    const feed = buildUpdaterFeed({
      version: "26.10.2",
      notes: "n",
      pubDate: "2026-10-14T12:00:00Z",
      entries: [
        { artifact: mac, url: "https://x/mac", signature: "S1" },
        { artifact: deb, url: "https://x/deb", signature: "S2" },
      ],
    });
    expect(Object.keys(feed.platforms).sort()).toEqual(["darwin-aarch64", "darwin-aarch64-app", "linux-x86_64-deb"]);
    expect(feed.platforms["linux-x86_64-deb"]).toEqual({ url: "https://x/deb", signature: "S2" });
    expect(feed).toMatchObject({ version: "26.10.2", pub_date: "2026-10-14T12:00:00Z" });
  });

  it("never gives Linux or Windows a plain platform key", () => {
    const keys = ARTIFACTS.flatMap((a) => a.platforms);
    expect(keys).not.toContain("linux-x86_64");
    expect(keys).not.toContain("windows-x86_64");
  });

  it("puts stable releases in both updater feeds and betas only in the beta feed", () => {
    expect(updaterChannelsFor("stable")).toEqual(["stable", "beta"]);
    expect(updaterChannelsFor("beta")).toEqual(["beta"]);
  });

  it("finds installers in nested folders and reports the missing ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "inkycap-release-"));
    mkdirSync(join(dir, "inkycap-windows-x86_64"));
    writeFileSync(join(dir, "InkyCap_26.10.2_amd64.deb"), "x");
    writeFileSync(join(dir, "inkycap-windows-x86_64", "InkyCap_26.10.2_x64-setup.exe"), "x");
    writeFileSync(join(dir, "InkyCap_26.10.0_amd64.deb"), "old version, ignored");
    const { found, missing } = findArtifacts(dir, "26.10.2");
    expect(found.map((f) => f.artifact.platforms[0]).sort()).toEqual(["linux-x86_64-deb", "windows-x86_64-nsis"]);
    expect(missing).toHaveLength(ARTIFACTS.length - 2);
  });
});

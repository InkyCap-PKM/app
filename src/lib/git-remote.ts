// Git remote-address helpers, shared by the collaboration panel (the SSH/HTTPS
// toggle) and the Settings clone flow. libgit2 picks the transport from the URL
// scheme, so keeping the address shape consistent with the chosen auth method
// is what makes a username/password vs. SSH-key choice actually take effect.

/** A remote address that uses SSH rather than HTTPS — anything not starting with
 *  `http://` / `https://` (e.g. `ssh://git@host/…` or `git@host:owner/repo`).
 *  Used to pre-select the "connect with SSH" option from an existing config. */
export function looksLikeSshRemote(remote: string): boolean {
  const r = remote.trim();
  return r !== "" && !/^https?:\/\//i.test(r);
}

/** Reduce any remote spelling to `host/owner/repo` (no scheme, user, or trailing
 *  slash). Mirrors the backend's `normalize_remote`. */
export function remoteParts(url: string): string {
  let s = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // drop scheme
  s = s.replace(/^[^@/]*@/, ""); // drop user@
  // scp-style `host:owner/repo` → `host/owner/repo` (only when the colon comes
  // before any slash, i.e. it's the host/path separator, not a port in a URL).
  const colon = s.indexOf(":");
  const slash = s.indexOf("/");
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    s = `${s.slice(0, colon)}/${s.slice(colon + 1)}`;
  }
  return s.replace(/\/+$/, "");
}

/** Rewrite a remote address to HTTPS, so a username/password choice is honoured
 *  (libgit2 picks SSH vs HTTPS from the URL scheme; a mismatched URL would
 *  silently ignore the credentials). Empty/unparseable input is left as-is. */
export function toHttpsRemote(url: string): string {
  const p = remoteParts(url);
  return p ? `https://${p}` : url.trim();
}

/** Rewrite a remote address to SSH (`ssh://git@host/…`), the counterpart of
 *  [`toHttpsRemote`] for the "connect with SSH" choice. */
export function toSshRemote(url: string): string {
  const p = remoteParts(url);
  return p ? `ssh://git@${p}` : url.trim();
}

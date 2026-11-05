// Minimal browser-like HTTP client: cookie jar, manual redirects, realistic headers.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function absorbCookies(jar, res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const sc of list) {
    const first = sc.split(";")[0];
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    if (/max-age=0\b/i.test(sc) || /expires=[^;]*1970/i.test(sc)) delete jar[k];
    else jar[k] = v;
  }
}

const cookieHeader = (jar) =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

/**
 * Fetch a page like a browser would: sends/receives cookies and follows redirects by hand
 * (so cookies set on 302 responses are kept). Returns the final page.
 */
export async function browse(url, { method = "GET", body = null, jar = {}, referer = null, maxHops = 8, timeoutMs = 30000 } = {}) {
  const hops = [];
  let current = url;
  let m = method;
  let b = body;
  for (let i = 0; i < maxHops; i++) {
    const headers = {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    };
    const ck = cookieHeader(jar);
    if (ck) headers.cookie = ck;
    if (referer) headers.referer = referer;
    if (b != null) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers.origin = new URL(current).origin;
    }
    const res = await fetch(current, {
      method: m,
      headers,
      body: b == null ? undefined : String(b),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    absorbCookies(jar, res);
    hops.push(`${m} ${new URL(current).pathname}${new URL(current).search} -> ${res.status}`);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      referer = current;
      current = new URL(loc, current).toString();
      if (res.status !== 307 && res.status !== 308) {
        m = "GET";
        b = null;
      }
      continue;
    }
    const html = await res.text();
    return { status: res.status, url: current, html, jar, hops };
  }
  throw new Error(`Too many redirects: ${hops.join(" | ")}`);
}

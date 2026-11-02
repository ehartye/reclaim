const TARGET_BYTES = 8192;
const BODY_BYTES = 128000;

export const requestError = (message, status = 400, code = "INVALID_REQUEST") =>
  Object.assign(new Error(message), { status, publicCode: code });

export function requestUrl(target, origin) {
  if (typeof target !== "string")
    throw requestError("Invalid request target.", 400, "INVALID_TARGET");
  if (Buffer.byteLength(target, "utf8") > TARGET_BYTES)
    throw requestError("Request target too large.", 414, "TARGET_TOO_LONG");
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    /[\\#\x00-\x20\x7f]/.test(target)
  )
    throw requestError("Invalid request target.", 400, "INVALID_TARGET");
  try {
    // Validate escapes without changing the route's encoded pathname.
    const decoded = decodeURIComponent(target);
    if (/[\x00-\x1f\x7f]/.test(decoded)) throw new URIError();
    const url = new URL(target, origin);
    if (url.origin !== origin) throw new URIError();
    return url;
  } catch {
    throw requestError("Invalid request target.", 400, "INVALID_TARGET");
  }
}

export function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.off("data", data);
      req.off("end", end);
      req.off("aborted", abort);
      req.off("error", abort);
      req.off("close", close);
    };
    const fail = (cause) => {
      cleanup();
      chunks.length = 0;
      // Pause rather than destroying the request so a 413 can still be sent.
      req.pause();
      reject(cause);
    };
    const abort = () =>
      fail(requestError("Request body incomplete.", 400, "INCOMPLETE_BODY"));
    const close = () => {
      if (!req.complete) abort();
    };
    const data = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length > BODY_BYTES - size) {
        fail(requestError("Request too large.", 413, "BODY_TOO_LARGE"));
        return;
      }
      size += bytes.length;
      chunks.push(bytes);
    };
    const end = () => {
      cleanup();
      if (!req.complete) {
        abort();
        return;
      }
      try {
        resolve(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            Buffer.concat(chunks, size),
          ),
        );
      } catch {
        reject(requestError("Invalid JSON.", 400, "INVALID_REQUEST"));
      }
    };
    req.on("data", data);
    req.once("end", end);
    req.once("aborted", abort);
    req.once("error", abort);
    req.once("close", close);
    if (req.destroyed || req.aborted) abort();
  });
}

export function sendJson(res, data, status = 200) {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    res.destroy();
    return;
  }
  // Serialization can throw; it must happen before committing response headers.
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const publicFailures = new Set([
  "Safety inspection limit reached. Choose a smaller folder.",
  "Safety inspection timed out. Narrow the target.",
  "Windows could not open this folder",
  "Windows did not acknowledge the folder request.",
  "Windows did not acknowledge the folder request in time. Try opening it again.",
]);
const errorCodes = new Set([
  "INVALID_REQUEST",
  "INVALID_TARGET",
  "TARGET_TOO_LONG",
  "INCOMPLETE_BODY",
  "BODY_TOO_LARGE",
  "INTERNAL_ERROR",
]);

export function respondToError(req, res, cause) {
  try {
    if (res.headersSent || res.writableEnded || res.destroyed) {
      res.destroy();
      return;
    }
    const status =
      Number.isInteger(cause?.status) &&
      cause.status >= 400 &&
      cause.status <= 599
        ? cause.status
        : 500;
    const message = typeof cause?.message === "string" ? cause.message : "";
    // Domain refusals retain their reason. Internal exceptions are not a public API.
    const safe =
      (status < 500 ||
        errorCodes.has(cause?.publicCode) ||
        publicFailures.has(message)) &&
      message.length <= 240 &&
      !/[\\/\x00-\x1f\x7f]/.test(message) &&
      !(
        req.headers["x-reclaim-token"] &&
        message.includes(req.headers["x-reclaim-token"])
      );
    const code =
      (errorCodes.has(cause?.publicCode) && cause.publicCode) ||
      (status >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST");
    res.setHeader("Connection", "close");
    sendJson(
      res,
      { error: safe ? message : "Request could not be completed.", code },
      status,
    );
  } catch {
    // Even a failed fallback is contained to this response.
    res.destroy();
  }
}

export function containRequest(handler) {
  return (req, res) => {
    // Stream errors can arrive after the async handler has settled.
    const close = () => res.destroy();
    req.on("error", close);
    res.on("error", close);
    void Promise.resolve()
      .then(() => handler(req, res))
      .catch((cause) => respondToError(req, res, cause));
  };
}

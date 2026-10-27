/**
 * Unit tests run in node, where the client's engine address is the app's own (127.0.0.1:8790): a call a test forgot
 * to stub would reach the user's running Prong. Such calls fail here instead, as an engine that is not running would.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init?: any) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost):879\d/.test(url)) return Promise.reject(new TypeError(`unit tests do not call the running Prong (${url})`));
  return realFetch(input, init);
}) as typeof fetch;

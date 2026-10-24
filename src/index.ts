interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}${responseHints(res)}`,
    res.url,
    res.status,
  );
}

/**
 * Facts about a FAILED response that live in its headers, not its body, appended
 * so the gateway's classifier (which only ever sees this string) can tell a limit
 * from a wall from a refusal (fleet #3477). Both are standard, both are absent on
 * almost every response, and neither is invented: `Retry-After` is the server
 * saying "come back later" (the one thing that makes a 403 a throttle), and
 * Cloudflare marks a bot challenge with `cf-mitigated: challenge`.
 */
function responseHints(res: Response): string {
  const hints: string[] = [];
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) hints.push(`retry-after: ${retryAfter.slice(0, 40)}`);
  if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') hints.push('Cloudflare bot challenge (cf-mitigated: challenge)');
  return hints.length ? ` (${hints.join('; ')})` : '';
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * China macro: PBOC Loan Prime Rate, headline NBS indicators (via Eastmoney's
 * data centre), 70-city house prices, SHIBOR and the CGB yield curve. Keyless.
 *
 * PBOC Loan Prime Rate (贷款市场报价利率, LPR) — the 1-year and 5-year benchmark
 * lending rates China's central bank (via the National Interbank Funding
 * Center / chinamoney.com.cn) publishes monthly on the 20th (or the next
 * business day). The 1-year rate anchors most corporate/consumer loans; the
 * 5-year rate anchors mortgages.
 *
 * Source: chinamoney.com.cn's own JSON data endpoints (the ones the site's own
 * chart widget calls) — keyless, no cookie/session, just a same-site Referer
 * header. Confirmed live 2026-09-08 (fleet task #1336, endpoint found by
 * #1311 via a browser network tab — the guessed `LprHisExcel` export path
 * 200s with an empty body and is NOT the route).
 *
 *   - History (rolling ~1 year, monthly): POST .../ags/ms/cm-u-bk-currency/LprHis?lang=CN
 *   - Latest print only:                  POST .../r/cms/www/chinamoney/data/currency/bk-lpr.json
 *
 * The history endpoint ignores date-range query params and always returns a
 * rolling window of ~12 monthly rows ending at the latest announcement — there
 * is no deeper history available from this call.
 *
 * Added 2026-10-18 (fleet #3298 — replaces the blocked direct-NBS route of
 * #3238 with a keyless republisher of the SAME National Bureau of Statistics
 * / PBOC figures, via Eastmoney's data-centre report API):
 *
 *  - china_macro_indicator — CPI, PPI, manufacturing/non-manufacturing PMI,
 *    quarterly (YTD-cumulative) GDP, industrial value-added growth, retail
 *    sales, fixed-asset investment, and M0/M1/M2 money supply, plus monthly
 *    customs export/import totals. One tool, an `indicator` enum, each
 *    mapped to its own Eastmoney RPT_ECONOMY_* reportName — same
 *    datacenter-web.eastmoney.com host + report-API shape already live in
 *    china-stocks (RPT_INDUSTRY_FUNDFLOW etc., verified CF-egress-OK
 *    2026-07-17 and reconfirmed 2026-10-17 fleet #3242), so no new egress
 *    risk. All ten reportNames probed keyless from a laptop 2026-10-18 and
 *    again live here; field names translated from NBS's own Chinese column
 *    names (same ones each report's data.eastmoney.com page displays).
 *  - china_house_prices — the NBS 70-city new-build/resale residential price
 *    indexes (index, prior-period = 100), by city and/or month. Same report
 *    family (RPT_ECONOMY_HOUSE_PRICE), filterable server-side by CITY and
 *    REPORT_DATE.
 *  - china_rates — SHIBOR (all 8 tenors, latest + history) from
 *    chinamoney.com.cn/CFETS (same host/shape as the LPR tools above, a
 *    sibling `cm-u-bk-shibor/ShiborHis` endpoint found the same way), plus
 *    the China Government Bond yield curve: the SDDS 1-year/10-year
 *    benchmark series with dates (IMF Special Data Dissemination Standard
 *    disclosure chinamoney publishes daily) and CFETS's real-time quoted
 *    benchmark-bond curve across the full maturity range. The task's
 *    candidate curve code "CYCC000" does not exist on chinamoney — the live
 *    mechanism found by reading the page's own JS is `bondType=100101`
 *    (国债/Treasury Bond) against the `RtimeYldCurv` endpoint.
 */


const UA = 'pipeworx-mcp-china-macro/1.0 (+https://pipeworx.io)';
const REFERER = 'https://www.chinamoney.com.cn/en/index.html';

async function pwFetch(url: string, name: string): Promise<Response> {
  return fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json' } },
    name,
  );
}

// Same chinamoney.com.cn host as the LPR calls above, different section
// (bkshibor / bkcurvrty / sddsintigy) — each page's own Referer, same POST
// shape. A generic version of pwFetch that takes its own Referer.
async function pwFetchCM(url: string, referer: string, name: string): Promise<Response> {
  return fetchWithTimeout(url, { method: 'POST', headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json' } }, name);
}

// Eastmoney's data-centre report API — the SAME host + shape china-stocks
// already calls live for RPT_INDUSTRY_FUNDFLOW/RPT_DAILYBILLBOARD_* etc.
// (datacenter-web.eastmoney.com, NOT the push2/push2his family, which is a
// separate, sometimes-blocked host — see china-stocks's own notes). Keyless;
// verified CF-egress-OK 2026-07-17, reconfirmed 2026-10-17.
const EASTMONEY_DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

async function eastmoneyQuery(reportName: string, extra: Record<string, string> = {}): Promise<Array<Record<string, unknown>>> {
  const qs = new URLSearchParams({
    reportName,
    columns: 'ALL',
    source: 'WEB',
    client: 'WEB',
    sortColumns: 'REPORT_DATE',
    sortTypes: '-1',
    pageNumber: '1',
    pageSize: '20',
    ...extra,
  });
  const res = await fetchWithTimeout(
    `${EASTMONEY_DC}?${qs}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (pipeworx.io)', Referer: 'https://data.eastmoney.com/' } },
    `Eastmoney data centre (${reportName})`,
  );
  if (!res.ok) throw await httpError(res, `Eastmoney data centre (${reportName})`);
  const body = (await res.json()) as { success?: boolean; code?: number; message?: string; result?: { data?: Array<Record<string, unknown>> } | null };
  if (body.success === false) {
    throw new Error(`Eastmoney data centre error${body.code ? ` (${body.code})` : ''}: ${body.message ?? 'unknown error'} — reportName=${reportName}`);
  }
  return body.result?.data ?? [];
}

const HIS_URL = 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/LprHis?lang=CN';
const LATEST_URL = 'https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/currency/bk-lpr.json';

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

interface LprHisRecord {
  '1Y'?: string;
  '5Y'?: string;
  showDateCN?: string;
  showDateEN?: string;
}

interface LprHisBody {
  data?: { startDateCN?: string; endDateCN?: string };
  records?: LprHisRecord[];
}

interface LprLatestRecord {
  termCode?: string;
  shibor?: string;
}

interface LprLatestBody {
  data?: { showDateCN?: string; showDateEN?: string };
  records?: LprLatestRecord[];
}

async function lprHistory(args: Record<string, unknown>) {
  const monthsArg = num(args.months);
  const months = monthsArg != null && monthsArg > 0 ? Math.min(Math.trunc(monthsArg), 12) : 12;

  const res = await pwFetch(HIS_URL, 'PBOC LPR history (chinamoney.com.cn)');
  if (!res.ok) throw await httpError(res, 'PBOC LPR history (chinamoney.com.cn)');
  const body = (await res.json()) as LprHisBody;
  const recordsRaw = Array.isArray(body.records) ? body.records : [];
  if (recordsRaw.length === 0) {
    return {
      found: false,
      message: 'chinamoney.com.cn returned no LPR history rows (upstream may be mid-update around the monthly 20th announcement) — retry shortly.',
      source: 'chinamoney.com.cn (National Interbank Funding Center, keyless)',
    };
  }

  const rows = recordsRaw
    .map((r) => ({
      reference_date: r.showDateCN ?? null,
      reference_date_en: r.showDateEN ?? null,
      lpr_1y_pct: num(r['1Y']),
      lpr_5y_pct: num(r['5Y']),
    }))
    .filter((r) => r.reference_date != null)
    .sort((a, b) => (a.reference_date! < b.reference_date! ? 1 : -1))
    .slice(0, months);

  const latest = rows[0] ?? null;

  return {
    found: true,
    range: { start: body.data?.startDateCN ?? null, end: body.data?.endDateCN ?? null },
    note: 'Rolling window of the most recent monthly LPR announcements (chinamoney.com.cn does not expose deeper history via this endpoint). LPR is announced monthly on the 20th (or next business day) by the National Interbank Funding Center under PBOC authorization; 1Y anchors most corporate/consumer loans, 5Y anchors mortgages.',
    latest,
    returned: rows.length,
    rows,
    source: 'chinamoney.com.cn (National Interbank Funding Center, keyless) — 贷款市场报价利率 (LPR)',
  };
}

// ── china_macro_indicator ───────────────────────────────────────────

/** "2026-09-01 00:00:00" -> "2026-09". Eastmoney's REPORT_DATE is always the
 * first of the reference month/quarter at local midnight. */
function periodFromReportDate(reportDate: unknown): string | null {
  const s = typeof reportDate === 'string' ? reportDate : null;
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-\d{2}/);
  return m ? `${m[1]}-${m[2]}` : s;
}

const INDICATOR_REPORTS: Record<string, string> = {
  cpi: 'RPT_ECONOMY_CPI',
  ppi: 'RPT_ECONOMY_PPI',
  pmi: 'RPT_ECONOMY_PMI',
  gdp: 'RPT_ECONOMY_GDP',
  industrial_production: 'RPT_ECONOMY_INDUS_GROW',
  retail_sales: 'RPT_ECONOMY_TOTAL_RETAIL',
  fixed_asset_investment: 'RPT_ECONOMY_ASSET_INVEST',
  money_supply: 'RPT_ECONOMY_CURRENCY_SUPPLY',
  trade: 'RPT_ECONOMY_CUSTOMS',
};

const INDICATOR_LABELS: Record<string, string> = {
  cpi: 'Consumer Price Index (CPI)',
  ppi: 'Producer Price Index (PPI)',
  pmi: 'Manufacturing & Non-Manufacturing Purchasing Managers’ Index (PMI)',
  gdp: 'Gross Domestic Product (GDP), year-to-date cumulative',
  industrial_production: 'Industrial value-added growth',
  retail_sales: 'Total retail sales of consumer goods',
  fixed_asset_investment: 'Fixed-asset investment (FAI)',
  money_supply: 'Money supply (M0/M1/M2)',
  trade: 'Customs export/import totals',
};

/** Translate one raw Eastmoney row (Chinese NBS field names) to English,
 * per indicator. Each indicator's reportName has its own column shape. */
function mapIndicatorRow(indicator: string, row: Record<string, unknown>): Record<string, unknown> {
  const period = periodFromReportDate(row.REPORT_DATE);
  const n = num;
  switch (indicator) {
    case 'cpi':
      return {
        period,
        national_yoy_pct: n(row.NATIONAL_SAME),
        national_mom_pct: n(row.NATIONAL_SEQUENTIAL),
        national_index_prior_year_month_eq_100: n(row.NATIONAL_BASE),
        national_ytd_avg_index_prior_year_eq_100: n(row.NATIONAL_ACCUMULATE),
        urban_yoy_pct: n(row.CITY_SAME),
        urban_mom_pct: n(row.CITY_SEQUENTIAL),
        rural_yoy_pct: n(row.RURAL_SAME),
        rural_mom_pct: n(row.RURAL_SEQUENTIAL),
      };
    case 'ppi':
      return {
        period,
        yoy_pct: n(row.BASE_SAME),
        index_prior_year_month_eq_100: n(row.BASE),
        ytd_avg_index_prior_year_eq_100: n(row.BASE_ACCUMULATE),
      };
    case 'pmi':
      return {
        period,
        manufacturing_pmi: n(row.MAKE_INDEX),
        manufacturing_pmi_yoy_change_pts: n(row.MAKE_SAME),
        non_manufacturing_pmi: n(row.NMAKE_INDEX),
        non_manufacturing_pmi_yoy_change_pts: n(row.NMAKE_SAME),
        note: 'PMI readings above 50 indicate expansion vs the prior month, below 50 contraction. *_yoy_change_pts is the published change vs the same month last year, in index points.',
      };
    case 'gdp': {
      const timeLabel = typeof row.TIME === 'string' ? row.TIME : null;
      return {
        period,
        period_label_cn: timeLabel,
        gdp_ytd_cumulative_cny_100m: n(row.DOMESTICL_PRODUCT_BASE),
        primary_sector_ytd_cumulative_cny_100m: n(row.FIRST_PRODUCT_BASE),
        secondary_sector_ytd_cumulative_cny_100m: n(row.SECOND_PRODUCT_BASE),
        tertiary_sector_ytd_cumulative_cny_100m: n(row.THIRD_PRODUCT_BASE),
        gdp_yoy_pct: n(row.SUM_SAME),
        primary_sector_yoy_pct: n(row.FIRST_SAME),
        secondary_sector_yoy_pct: n(row.SECOND_SAME),
        tertiary_sector_yoy_pct: n(row.THIRD_SAME),
        note: 'NBS publishes GDP as a year-to-date cumulative figure through the stated quarter (e.g. "H1" = Q1+Q2 combined), not an isolated single quarter.',
      };
    }
    case 'industrial_production':
      return {
        period,
        value_added_yoy_pct: n(row.BASE_SAME),
        value_added_ytd_yoy_pct: n(row.BASE_ACCUMULATE),
      };
    case 'retail_sales':
      return {
        period,
        retail_sales_cny_100m: n(row.RETAIL_TOTAL),
        retail_sales_yoy_pct: n(row.RETAIL_TOTAL_SAME),
        retail_sales_mom_pct: n(row.RETAIL_TOTAL_SEQUENTIAL),
        retail_sales_ytd_cumulative_cny_100m: n(row.RETAIL_TOTAL_ACCUMULATE),
        retail_sales_ytd_yoy_pct: n(row.RETAIL_ACCUMULATE_SAME),
      };
    case 'fixed_asset_investment':
      return {
        period,
        fai_monthly_cny_100m: n(row.BASE),
        fai_yoy_pct: n(row.BASE_SAME),
        fai_mom_pct: n(row.BASE_SEQUENTIAL),
        fai_ytd_cumulative_cny_100m: n(row.BASE_ACCUMULATE),
        note: 'NBS officially discloses fixed-asset investment only as a year-to-date cumulative figure; fai_monthly_* is Eastmoney’s own derived single-month breakout.',
      };
    case 'money_supply':
      return {
        period,
        m2_outstanding_cny_100m: n(row.BASIC_CURRENCY),
        m2_yoy_pct: n(row.BASIC_CURRENCY_SAME),
        m2_mom_pct: n(row.BASIC_CURRENCY_SEQUENTIAL),
        m1_outstanding_cny_100m: n(row.CURRENCY),
        m1_yoy_pct: n(row.CURRENCY_SAME),
        m1_mom_pct: n(row.CURRENCY_SEQUENTIAL),
        m0_outstanding_cny_100m: n(row.FREE_CASH),
        m0_yoy_pct: n(row.FREE_CASH_SAME),
        m0_mom_pct: n(row.FREE_CASH_SEQUENTIAL),
        note: 'M1 reflects the PBOC’s 2024 broadened definition (adds individual demand deposits and certain non-bank payment-account balances), so it is not comparable to pre-2024 M1 levels.',
      };
    case 'trade': {
      const exportsUsdBn = n(row.EXIT_BASE);
      const importsUsdBn = n(row.IMPORT_BASE);
      return {
        period,
        exports_usd_bn: exportsUsdBn != null ? Math.round((exportsUsdBn / 1e6) * 1e4) / 1e4 : null,
        exports_yoy_pct: n(row.EXIT_BASE_SAME),
        exports_mom_pct: n(row.EXIT_BASE_SEQUENTIAL),
        imports_usd_bn: importsUsdBn != null ? Math.round((importsUsdBn / 1e6) * 1e4) / 1e4 : null,
        imports_yoy_pct: n(row.IMPORT_BASE_SAME),
        imports_mom_pct: n(row.IMPORT_BASE_SEQUENTIAL),
        exports_ytd_cumulative_usd_bn: (() => {
          const v = n(row.EXIT_ACCUMULATE);
          return v != null ? Math.round((v / 1e6) * 1e2) / 1e2 : null;
        })(),
        exports_ytd_yoy_pct: n(row.EXIT_ACCUMULATE_SAME),
        imports_ytd_cumulative_usd_bn: (() => {
          const v = n(row.IMPORT_ACCUMULATE);
          return v != null ? Math.round((v / 1e6) * 1e2) / 1e2 : null;
        })(),
        imports_ytd_yoy_pct: n(row.IMPORT_ACCUMULATE_SAME),
        note: 'General Administration of Customs totals are quoted in USD here; Eastmoney’s underlying report carries them in thousand-USD, converted to USD billions.',
      };
    }
    default:
      return { period, ...row };
  }
}

async function chinaMacroIndicator(args: Record<string, unknown>) {
  const indicator = typeof args.indicator === 'string' ? args.indicator : '';
  const reportName = INDICATOR_REPORTS[indicator];
  if (!reportName) {
    return {
      found: false,
      message: `Unknown indicator "${indicator}". Valid values: ${Object.keys(INDICATOR_REPORTS).join(', ')}.`,
    };
  }
  const periodsArg = num(args.periods);
  const periods = periodsArg != null && periodsArg > 0 ? Math.min(Math.trunc(periodsArg), 36) : 12;

  const rowsRaw = await eastmoneyQuery(reportName, { pageSize: String(periods) });
  if (rowsRaw.length === 0) {
    return {
      found: false,
      indicator,
      message: 'Eastmoney’s data centre returned no rows for this report right now — retry shortly.',
      source: 'National Bureau of Statistics of China, via Eastmoney data centre (keyless)',
    };
  }

  const history = rowsRaw.map((r) => mapIndicatorRow(indicator, r));
  const latest = history[0] ?? null;

  return {
    found: true,
    indicator,
    indicator_label: INDICATOR_LABELS[indicator] ?? indicator,
    latest,
    returned: history.length,
    history,
    data_as_of: latest?.period ?? null,
    source:
      indicator === 'trade'
        ? 'General Administration of Customs of China, monthly trade totals, via Eastmoney data centre (keyless)'
        : 'National Bureau of Statistics of China, via Eastmoney data centre (keyless)',
  };
}

// ── china_house_prices ──────────────────────────────────────────────

const HOUSE_PRICE_REPORT = 'RPT_ECONOMY_HOUSE_PRICE';

// NBS covers exactly 70 cities in this release. Chinese name -> English name,
// built from the live city list returned by the report itself (2026-10-18).
const CITY_EN: Record<string, string> = {
  '三亚': 'Sanya', '上海': 'Shanghai', '丹东': 'Dandong', '乌鲁木齐': 'Urumqi',
  '九江': 'Jiujiang', '兰州': 'Lanzhou', '包头': 'Baotou', '北京': 'Beijing',
  '北海': 'Beihai', '南京': 'Nanjing', '南充': 'Nanchong', '南宁': 'Nanning',
  '南昌': 'Nanchang', '厦门': 'Xiamen', '合肥': 'Hefei', '吉林': 'Jilin',
  '呼和浩特': 'Hohhot', '哈尔滨': 'Harbin', '唐山': 'Tangshan', '大理': 'Dali',
  '大连': 'Dalian', '天津': 'Tianjin', '太原': 'Taiyuan', '宁波': 'Ningbo',
  '安庆': 'Anqing', '宜昌': 'Yichang', '岳阳': 'Yueyang', '常德': 'Changde',
  '平顶山': 'Pingdingshan', '广州': 'Guangzhou', '徐州': 'Xuzhou', '惠州': 'Huizhou',
  '成都': 'Chengdu', '扬州': 'Yangzhou', '无锡': 'Wuxi', '昆明': 'Kunming',
  '杭州': 'Hangzhou', '桂林': 'Guilin', '武汉': 'Wuhan', '沈阳': 'Shenyang',
  '泉州': 'Quanzhou', '泸州': 'Luzhou', '洛阳': 'Luoyang', '济南': 'Jinan',
  '济宁': 'Jining', '海口': 'Haikou', '深圳': 'Shenzhen', '温州': 'Wenzhou',
  '湛江': 'Zhanjiang', '烟台': 'Yantai', '牡丹江': 'Mudanjiang', '石家庄': 'Shijiazhuang',
  '福州': 'Fuzhou', '秦皇岛': 'Qinhuangdao', '蚌埠': 'Bengbu', '襄阳': 'Xiangyang',
  '西宁': 'Xining', '西安': "Xi'an", '贵阳': 'Guiyang', '赣州': 'Ganzhou',
  '遵义': 'Zunyi', '郑州': 'Zhengzhou', '重庆': 'Chongqing', '金华': 'Jinhua',
  '银川': 'Yinchuan', '锦州': 'Jinzhou', '长春': 'Changchun', '长沙': 'Changsha',
  '青岛': 'Qingdao', '韶关': 'Shaoguan',
};
const CITY_EN_TO_CN: Record<string, string> = Object.fromEntries(Object.entries(CITY_EN).map(([cn, en]) => [en.toLowerCase(), cn]));

function mapHousePriceRow(row: Record<string, unknown>) {
  const cn = typeof row.CITY === 'string' ? row.CITY : null;
  return {
    period: periodFromReportDate(row.REPORT_DATE),
    city: cn ? CITY_EN[cn] ?? cn : null,
    city_cn: cn,
    new_build_index_yoy_prior_year_eq_100: num(row.FIRST_COMHOUSE_SAME),
    new_build_index_mom_prior_month_eq_100: num(row.FIRST_COMHOUSE_SEQUENTIAL),
    resale_index_yoy_prior_year_eq_100: num(row.SECOND_HOUSE_SAME),
    resale_index_mom_prior_month_eq_100: num(row.SECOND_HOUSE_SEQUENTIAL),
  };
}

async function chinaHousePrices(args: Record<string, unknown>) {
  const cityArg = typeof args.city === 'string' ? args.city.trim() : '';
  const monthArg = typeof args.month === 'string' ? args.month.trim() : '';

  const filters: string[] = [];
  let cityCn: string | null = null;
  if (cityArg) {
    cityCn = CITY_EN[cityArg] ? cityArg : CITY_EN_TO_CN[cityArg.toLowerCase()] ?? null;
    if (!cityCn) {
      return {
        found: false,
        message: `"${cityArg}" is not one of the 70 cities NBS covers in this release. Call without \`city\` to see the full list (one row per city for the latest month).`,
        cities: Object.values(CITY_EN).sort(),
      };
    }
    filters.push(`(CITY="${cityCn}")`);
  }
  if (monthArg && /^\d{4}-\d{2}$/.test(monthArg)) {
    filters.push(`(REPORT_DATE='${monthArg}-01 00:00:00')`);
  }

  const extra: Record<string, string> = {};
  if (filters.length > 0) extra.filter = filters.join(' and ');
  // One city, no month -> up to 24 months of that city's history. No city
  // (any month) -> that month's full 70-city cross-section, sorted by city.
  if (cityCn && !monthArg) {
    extra.pageSize = '24';
  } else if (!cityCn) {
    extra.pageSize = '70';
  } else {
    extra.pageSize = '5';
  }

  const rowsRaw = await eastmoneyQuery(HOUSE_PRICE_REPORT, extra);
  if (rowsRaw.length === 0) {
    return {
      found: false,
      message: 'Eastmoney’s data centre returned no rows for this city/month combination — retry shortly, or try without `month` for the latest release.',
      source: 'National Bureau of Statistics of China, 70-city residential price index, via Eastmoney data centre (keyless)',
    };
  }

  // No city filter: the server-side sort mixes months if more than one
  // period is present; pin to the most recent REPORT_DATE in the page.
  let rows = rowsRaw;
  if (!cityCn) {
    const latestPeriod = rowsRaw.reduce<string | null>((best, r) => {
      const p = typeof r.REPORT_DATE === 'string' ? r.REPORT_DATE : null;
      return p && (best === null || p > best) ? p : best;
    }, null);
    rows = rowsRaw.filter((r) => r.REPORT_DATE === latestPeriod);
  }

  const mapped = rows.map(mapHousePriceRow);
  const data_as_of = mapped[0]?.period ?? null;

  return {
    found: true,
    note: 'Indexes use the prior period (same month last year for *_yoy, prior month for *_mom) = 100 — a value above 100 is a price rise, below 100 a fall. new_build = 新建商品住宅价格指数 (newly-built commercial residential); resale = 二手住宅价格指数 (existing/resale residential).',
    cities_returned: cityCn ? 1 : new Set(mapped.map((r) => r.city_cn)).size,
    returned: mapped.length,
    data_as_of,
    rows: mapped,
    source: 'National Bureau of Statistics of China, 70-city residential price index, via Eastmoney data centre (keyless)',
  };
}

// ── china_rates: SHIBOR + CGB yield curve ───────────────────────────

const SHIBOR_LATEST_URL = 'https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/shibor/shibor.json';
const SHIBOR_HIS_BASE = 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-shibor/ShiborHis';
const SDDS_GOV_YIELD_URL = 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/SddsIntrRateGovYldHis';
const RTIME_YLD_CURV_URL = 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/RtimeYldCurv';
const CM_SHIBOR_REFERER = 'https://www.chinamoney.com.cn/chinese/bkshibor/';
const CM_SDDS_REFERER = 'https://www.chinamoney.com.cn/chinese/sddsintigy/';
const CM_CURVE_REFERER = 'https://www.chinamoney.com.cn/chinese/bkcurvrty/';

const SHIBOR_TENORS = ['ON', '1W', '2W', '1M', '3M', '6M', '9M', '1Y'] as const;
const SHIBOR_TENOR_LABEL: Record<string, string> = {
  ON: 'overnight', '1W': '1-week', '2W': '2-week', '1M': '1-month',
  '3M': '3-month', '6M': '6-month', '9M': '9-month', '1Y': '1-year',
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function chinaRatesShibor(args: Record<string, unknown>) {
  const daysArg = num(args.days);
  // ~1 calendar month of history if omitted; SHIBOR fixes on every CN
  // business day, so request extra calendar days to clear weekends/holidays.
  const days = daysArg != null && daysArg > 0 ? Math.min(Math.trunc(daysArg), 365) : 30;

  const [latestRes, hisRes] = await Promise.all([
    pwFetchCM(SHIBOR_LATEST_URL, CM_SHIBOR_REFERER, 'SHIBOR latest fixing (chinamoney.com.cn)'),
    pwFetchCM(
      `${SHIBOR_HIS_BASE}?lang=CN&startDate=${isoDaysAgo(days)}&endDate=${isoDaysAgo(0)}`,
      CM_SHIBOR_REFERER,
      'SHIBOR history (chinamoney.com.cn)',
    ),
  ]);
  if (!latestRes.ok) throw await httpError(latestRes, 'SHIBOR latest fixing (chinamoney.com.cn)');
  if (!hisRes.ok) throw await httpError(hisRes, 'SHIBOR history (chinamoney.com.cn)');

  const latestBody = (await latestRes.json()) as { data?: { showDateCN?: string }; records?: Array<{ termCode?: string; shibor?: string }> };
  const hisBody = (await hisRes.json()) as { data?: { startDateCN?: string; endDateCN?: string }; records?: Array<Record<string, string>> };

  const latestByTerm: Record<string, number | null> = {};
  for (const r of latestBody.records ?? []) {
    // The latest-fixing endpoint spells overnight "O/N"; the history
    // endpoint spells it "ON" — normalize so both share one tenor key.
    if (r.termCode) latestByTerm[r.termCode === 'O/N' ? 'ON' : r.termCode] = num(r.shibor);
  }
  const latest: Record<string, unknown> = { reference_date: latestBody.data?.showDateCN ?? null };
  for (const t of SHIBOR_TENORS) latest[`${SHIBOR_TENOR_LABEL[t]}_pct`] = latestByTerm[t] ?? null;

  const history = (hisBody.records ?? [])
    .map((r) => {
      const row: Record<string, unknown> = { date: r.showDateCN ?? null };
      for (const t of SHIBOR_TENORS) row[`${SHIBOR_TENOR_LABEL[t]}_pct`] = num(r[t]);
      return row;
    })
    .filter((r) => r.date != null)
    .sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1));

  return {
    found: true,
    series: 'shibor',
    latest,
    range: { start: hisBody.data?.startDateCN ?? null, end: hisBody.data?.endDateCN ?? null },
    returned: history.length,
    history,
    data_as_of: latest.reference_date ?? null,
    note: 'Shanghai Interbank Offered Rate — the benchmark unsecured interbank lending rate, fixed each CN business day at 11:00 Beijing time as a trimmed average of 18 quoting banks’ submissions across 8 tenors.',
    source: 'China Foreign Exchange Trade System / National Interbank Funding Center, Shibor fixing (keyless)',
  };
}

async function chinaRatesYieldCurve(args: Record<string, unknown>) {
  const periodsArg = num(args.periods);
  const periods = periodsArg != null && periodsArg > 0 ? Math.min(Math.trunc(periodsArg), 60) : 20;

  const [sddsRes, curveRes] = await Promise.all([
    pwFetchCM(`${SDDS_GOV_YIELD_URL}?lang=CN&pageNum=1&pageSize=${periods}`, CM_SDDS_REFERER, 'China Government Bond 1Y/10Y yield history (chinamoney.com.cn)'),
    pwFetchCM(`${RTIME_YLD_CURV_URL}?lang=CN&bondType=100101`, CM_CURVE_REFERER, 'China Government Bond real-time yield curve (chinamoney.com.cn)'),
  ]);
  if (!sddsRes.ok) throw await httpError(sddsRes, 'China Government Bond 1Y/10Y yield history (chinamoney.com.cn)');
  if (!curveRes.ok) throw await httpError(curveRes, 'China Government Bond real-time yield curve (chinamoney.com.cn)');

  const sddsBody = (await sddsRes.json()) as {
    data?: { startDateCN?: string; endDateCN?: string };
    records?: Array<{ dateString?: string; oneRate?: string; tenRate?: string }>;
  };
  const curveBody = (await curveRes.json()) as {
    data?: {
      date?: string;
      records?: unknown;
    };
    records?: Array<{ bondcode?: string; name?: string; tl?: number; remainingMaturity?: number; buyYield?: number; sellYield?: number; avgYield?: number }>;
  };

  const benchmarkHistory = (sddsBody.records ?? [])
    .map((r) => ({ date: r.dateString ?? null, yield_1y_pct: num(r.oneRate), yield_10y_pct: num(r.tenRate) }))
    .filter((r) => r.date != null)
    .sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1));

  const curvePoints = (curveBody.records ?? [])
    .map((r) => ({
      bond_name: r.name ?? null,
      remaining_maturity_years: typeof r.remainingMaturity === 'number' ? r.remainingMaturity : null,
      buy_yield_pct: typeof r.buyYield === 'number' ? r.buyYield : null,
      sell_yield_pct: typeof r.sellYield === 'number' ? r.sellYield : null,
      mid_yield_pct: typeof r.avgYield === 'number' ? r.avgYield : null,
    }))
    .filter((p) => p.remaining_maturity_years != null)
    .sort((a, b) => (a.remaining_maturity_years! - b.remaining_maturity_years!));

  const latestBenchmark = benchmarkHistory[0] ?? null;
  const tenY = curvePoints.length > 0
    ? curvePoints.reduce((best, p) => (Math.abs(p.remaining_maturity_years! - 10) < Math.abs(best.remaining_maturity_years! - 10) ? p : best))
    : null;

  return {
    found: true,
    series: 'yield_curve',
    latest_1y_10y: latestBenchmark,
    curve_date: curveBody.data?.date ?? null,
    curve_closest_to_10y: tenY,
    curve_points_returned: curvePoints.length,
    curve_points: curvePoints,
    benchmark_history_returned: benchmarkHistory.length,
    benchmark_history: benchmarkHistory,
    data_as_of: curveBody.data?.date ?? latestBenchmark?.date ?? null,
    note: 'latest_1y_10y/benchmark_history are the IMF SDDS-disclosure 1-year and 10-year China Government Bond yields (dated, daily). curve_points is the full real-time quoted-yield curve across all actively-quoted CGB maturities (CFETS best bid/ask/mid), from ~1 month to ~50 years remaining maturity, for Treasury bonds (bondType 100101) — the closest keyless equivalent to a standard tenor-by-tenor curve.',
    source: 'China Foreign Exchange Trade System, China Government Bond yields (keyless)',
  };
}

async function lprLatest() {
  const res = await pwFetch(LATEST_URL, 'PBOC LPR latest print (chinamoney.com.cn)');
  if (!res.ok) throw await httpError(res, 'PBOC LPR latest print (chinamoney.com.cn)');
  const body = (await res.json()) as LprLatestBody;
  const recordsRaw = Array.isArray(body.records) ? body.records : [];
  if (recordsRaw.length === 0) {
    return {
      found: false,
      message: 'chinamoney.com.cn returned no LPR print — upstream may be mid-update.',
      source: 'chinamoney.com.cn (National Interbank Funding Center, keyless)',
    };
  }
  const byTerm: Record<string, number | null> = {};
  for (const r of recordsRaw) {
    if (r.termCode) byTerm[r.termCode] = num(r.shibor);
  }
  return {
    found: true,
    reference_date: body.data?.showDateCN ?? null,
    reference_date_en: body.data?.showDateEN ?? null,
    lpr_1y_pct: byTerm['1Y'] ?? null,
    lpr_5y_pct: byTerm['5Y'] ?? null,
    note: '1Y anchors most corporate/consumer loans, 5Y anchors mortgages. Announced monthly on the 20th (or next business day).',
    source: 'chinamoney.com.cn (National Interbank Funding Center, keyless) — 贷款市场报价利率 (LPR)',
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'china_lpr',
    description:
      "China's PBOC Loan Prime Rate (贷款市场报价利率, LPR) history — the 1-year and 5-year benchmark lending rates, each with its official reference/announcement date. Published monthly on the 20th (or next business day) by the National Interbank Funding Center under PBOC authorization. The 1-year rate anchors most corporate and consumer loans; the 5-year rate anchors mortgages. Returns up to the last 12 monthly announcements (chinamoney.com.cn does not expose history deeper than ~1 year via this endpoint) plus a `latest` field for the most recent print. Answers \"what is the current PBOC LPR\", \"China's 1-year and 5-year loan prime rate history\", \"when did the PBOC last cut the LPR\". Keyless, sourced live from chinamoney.com.cn.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        months: {
          type: 'number',
          description: 'How many of the most recent monthly rows to return, 1-12 (default 12). The upstream only exposes a rolling ~1-year window, so values above 12 are capped at 12.',
        },
      },
    },
  },
  {
    name: 'china_lpr_latest',
    description:
      "China's most recent PBOC Loan Prime Rate (贷款市场报价利率一年期/五年期, LPR 1Y/5Y) print only — a cheap single-row call for just the current 1-year and 5-year rates and their official reference/announcement date, without the 12-month history. Use china_lpr instead if you need the trend over time. Keyless, sourced live from chinamoney.com.cn.",
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'china_macro_indicator',
    description:
      "China's headline National Bureau of Statistics (NBS) macro indicators — one tool, pick an `indicator`: `cpi` (Consumer Price Index, national/urban/rural, y/y + m/m), `ppi` (Producer Price Index), `pmi` (manufacturing + non-manufacturing Purchasing Managers' Index), `gdp` (quarterly GDP, published as year-to-date cumulative, by sector), `industrial_production` (industrial value-added growth), `retail_sales` (total retail sales of consumer goods), `fixed_asset_investment` (FAI), `money_supply` (M0/M1/M2 outstanding + growth), or `trade` (General Administration of Customs monthly export/import totals in USD). Returns the latest period's values first (with its period, e.g. \"2026-09\"), then up to `periods` months/quarters of history, newest first — every Chinese NBS field name translated to an English name with its unit and the index convention it uses (prior-period = 100 unless stated otherwise). Answers \"China's latest CPI\", \"China PMI history\", \"China Q2 GDP growth\", \"China M2 money supply\", \"China's trade surplus last month\". Keyless, sourced live from the National Bureau of Statistics of China (General Administration of Customs for `trade`), via Eastmoney's data centre.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        indicator: {
          type: 'string',
          enum: ['cpi', 'ppi', 'pmi', 'gdp', 'industrial_production', 'retail_sales', 'fixed_asset_investment', 'money_supply', 'trade'],
          description: 'Which NBS/Customs indicator to return.',
        },
        periods: {
          type: 'number',
          description: 'How many of the most recent monthly/quarterly rows to return, 1-36 (default 12).',
        },
      },
      required: ['indicator'],
    },
  },
  {
    name: 'china_house_prices',
    description:
      "China's NBS 70-city residential price indexes — new-build commercial housing (新建商品住宅) and resale/existing housing (二手住宅), year-on-year and month-on-month, for Beijing, Shanghai, Shenzhen, and 67 other NBS-tracked cities. Pass `city` (English name, e.g. \"Beijing\") for that city's history (up to 24 months); pass `month` (\"YYYY-MM\") to pin a specific release; pass neither for the latest month's full 70-city cross-section. Index values use the prior period = 100 convention (e.g. 97.7 = a 2.3% year-on-year fall). Answers \"Beijing home price index\", \"which Chinese cities have falling house prices\", \"China 70-city house price index for August\". Keyless, sourced live from the National Bureau of Statistics of China, via Eastmoney's data centre.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'One of the 70 NBS-tracked cities, by English name (e.g. "Shanghai", "Chengdu"). Omit for all 70 cities in the latest month.' },
        month: { type: 'string', description: 'A specific release month as "YYYY-MM" (e.g. "2026-08"). Omit for the latest available month.' },
      },
    },
  },
  {
    name: 'china_rates',
    description:
      "China's money-market and government-bond benchmark rates. `series: \"shibor\"` returns the Shanghai Interbank Offered Rate across all 8 tenors (overnight through 1-year) — the latest 11:00-Beijing-time fixing plus up to `days` of daily history. `series: \"yield_curve\"` returns the China Government Bond yield curve: the dated 1-year/10-year benchmark series (IMF SDDS disclosure) plus CFETS's real-time quoted-yield curve across every actively-traded CGB maturity (~1 month to ~50 years). Answers \"current SHIBOR rates\", \"China's 10-year government bond yield\", \"China yield curve history\". Keyless, sourced live from the China Foreign Exchange Trade System / National Interbank Funding Center.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        series: { type: 'string', enum: ['shibor', 'yield_curve'], description: 'Which rate series to return.' },
        days: { type: 'number', description: '(shibor only) How many calendar days of history to request, 1-365 (default 30).' },
        periods: { type: 'number', description: '(yield_curve only) How many daily rows of the 1Y/10Y benchmark history to return, 1-60 (default 20).' },
      },
      required: ['series'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'china_lpr':
      return lprHistory(args);
    case 'china_lpr_latest':
      return lprLatest();
    case 'china_macro_indicator':
      return chinaMacroIndicator(args);
    case 'china_house_prices':
      return chinaHousePrices(args);
    case 'china_rates': {
      const series = typeof args.series === 'string' ? args.series : '';
      if (series === 'shibor') return chinaRatesShibor(args);
      if (series === 'yield_curve') return chinaRatesYieldCurve(args);
      return { found: false, message: `Unknown series "${series}". Valid values: shibor, yield_curve.` };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

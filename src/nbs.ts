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
 * National Bureau of Statistics of China, national and provincial statistics
 * database -- direct read of the publisher's own platform (fleet #3591).
 *
 * Rules this module is built around, each learned the expensive way:
 *
 *  1. The platform splits one series across several catalog nodes by year
 *     range (e.g. CPI "2026-" and "2021-2025"). Asking a node for a period it
 *     does not own answers HTTP 200 with a blank value, not an error. So blank
 *     values are never returned as data: they are dropped and counted, and an
 *     older node is consulted for the remainder where one exists.
 *  2. The platform's own `dp_name` metadata is wrong for some series (capacity
 *     utilisation labels a cumulative level "yoy change"). Period type, unit
 *     and base are therefore read from each indicator's LABEL, and compared with
 *     what the series table expects. Disagreement or an unreadable label is
 *     returned as basis_status "unresolved" with the raw value, never guessed.
 *  3. A published unit of "%" can sit on an index with base 100 (provincial
 *     CPI). The unit we return is derived from the label, the published one is
 *     kept alongside it.
 *  4. showType 2 + an explicit `das` list is the only form that carries a region
 *     code on each row; the filter is honoured (one region in, one row out).
 */


const NBS_BASE = 'https://data.stats.gov.cn/dg/website/publicrelease/web/external';
const UA = 'pipeworx-mcp-china-macro/1.0 (+https://pipeworx.io)';

const ROOT_MONTHLY = 'fc982599aa684be7969d7b90b1bd0e84';
const ROOT_QUARTERLY = 'a94b8b7365a94874968cabbe392cf679';
const ROOT_PROV_MONTHLY = 'f4c6cd795fea436c807163397dd36b98';
const ROOT_PROV_QUARTERLY = '854f819b04104191a5ae2f2cba270e6c';

export const SOURCE_NAME = 'National Bureau of Statistics of China, national and provincial statistics database';

type Freq = 'M' | 'Q';

interface Epoch {
  cid: string;
  ind: string;
  /** Last calendar year this node owns (undefined = current node). */
  endYear?: number;
}

export interface NbsSeriesDef {
  id: string;
  freq: Freq;
  /** Expected measure, checked against the label read from the live response. */
  expect: string;
  /** Newest node first. */
  epochs: Epoch[];
  /** Only national series carry `national`; provincial ones carry `provincial`. */
  scope: 'national' | 'provincial';
}

const nat = (id: string, freq: Freq, expect: string, epochs: Epoch[]): NbsSeriesDef => ({ id, freq, expect, epochs, scope: 'national' });
const prov = (id: string, freq: Freq, expect: string, epochs: Epoch[]): NbsSeriesDef => ({ id, freq, expect, epochs, scope: 'provincial' });

/** Closed set of series, one list per indicator. Ids enumerated from the
 * platform's own catalog tree and indicator lists on 2026-10-25. */
export const NBS_SERIES: Record<string, NbsSeriesDef[]> = {
  cpi: [
    nat('cpi_yoy_index', 'M', 'index', [
      { cid: '5c7452825c7c4dcba391db5ca7f335c5', ind: '53180dfb9c14411ba4b762307c85920c' },
      { cid: '809d2522b0fe4be89142650341b19083', ind: '4ae9047687934a6390984c21d6ddab96', endYear: 2025 },
    ]),
    nat('cpi_mom_index', 'M', 'index', [
      { cid: 'b4fad2cf9e0e4af7815b7e9e2e95c5c7', ind: 'f3904a1f5a384d54a3944ec6e2df3d1c' },
      { cid: 'e6664817f0cd427783cd397770695634', ind: 'e437d965279d41ceb9ace591b62f6ffc', endYear: 2025 },
    ]),
    prov('cpi_yoy_index', 'M', 'index', [
      { cid: 'b5e122302ad745358ba7415bd4a22c2f', ind: '02d75ee002764e2ea53f263e52109e8f' },
      { cid: 'c7b31f465b2b4a40b9999090b03b5a37', ind: 'a2713908ee9a4a86a6e1bf90a6c1df68', endYear: 2025 },
    ]),
  ],
  ppi: [
    nat('ppi_yoy_index', 'M', 'index', [{ cid: '60e8b361f11c4a878c652a6487a25561', ind: '150633e52b9a470a9a9fd1b296dd6c5b' }]),
    nat('ppi_mom_index', 'M', 'index', [{ cid: '677cfbb4f06941af8c1761c4804e58cf', ind: 'e64079bae9064aebad1c4c5fe0c8a6ef' }]),
    prov('ppi_yoy_index', 'M', 'index', [{ cid: 'f4978fd800d945989894083a156d94ed', ind: 'd91f353ef582487e916dee235383cf4f' }]),
  ],
  pmi: [
    nat('manufacturing_pmi', 'M', 'diffusion_index', [{ cid: '93ffbb1aa85740d3aa2618371508b606', ind: 'a09aa989bdcf4cffa2021795722eb916' }]),
    nat('non_manufacturing_business_activity_index', 'M', 'diffusion_index', [{ cid: '7a64a6e25aec4a8e9dde044ecd9e2cce', ind: '88a150208f6e4a1db8babe41ae700f66' }]),
    nat('composite_pmi_output_index', 'M', 'diffusion_index', [{ cid: '455378e1c3264a32875768a35ba5de76', ind: '55cdc89fa122446aa263912bdf14a540' }]),
  ],
  gdp: [
    nat('gdp_single_quarter_cny_100m', 'Q', 'level', [{ cid: '28d936104e304aa191e338eb82b6dc09', ind: 'd22612f09aeb4241bc557ef0ac61b3ba' }]),
    nat('gdp_ytd_cny_100m', 'Q', 'level', [{ cid: '28d936104e304aa191e338eb82b6dc09', ind: '8c5fab362d124fa7b91af833b3bd7397' }]),
    nat('gdp_ytd_index_prior_year_period', 'Q', 'index', [{ cid: 'f9b694c9b79e4ce5958bc88c6410fa67', ind: 'f5b82b2b6ad345a29a337d256a9d5ded' }]),
    nat('gdp_qoq_growth_pct', 'Q', 'pct_change_qoq', [{ cid: '2b0aa179980e41b8b636037ebae01d91', ind: '88bcaf76058e49b08a45b14a204b2d3d' }]),
    prov('regional_gdp_ytd_cny_100m', 'Q', 'level', [{ cid: '44ecf9ea21884caea5451c35e9c08fff', ind: 'dc168397231c49f391ee9e11966de389' }]),
    prov('regional_gdp_ytd_index_prior_year_period', 'Q', 'index', [{ cid: '44ecf9ea21884caea5451c35e9c08fff', ind: '23c7f329424d4e90b22abc092a5b676f' }]),
  ],
  industrial_production: [
    nat('industrial_value_added_yoy_pct', 'M', 'pct_change_yoy', [{ cid: '3f2e14f0542348ed9fe02476eca3450b', ind: 'ef1b1765960d45a29b4d7c4ca91be916' }]),
    nat('industrial_value_added_ytd_yoy_pct', 'M', 'pct_change_yoy', [{ cid: '3f2e14f0542348ed9fe02476eca3450b', ind: '21e7072e9f384209aedb56e69a18216e' }]),
    prov('industrial_value_added_yoy_pct', 'M', 'pct_change_yoy', [{ cid: '9593fb551802499683f758e0f6f45bc7', ind: '6e073cf3b36644e6bee881d312c95681' }]),
  ],
  retail_sales: [
    nat('retail_sales_single_month_cny_100m', 'M', 'level', [{ cid: 'd0cb882c7f27443ab6b3ef9421901961', ind: '1142a3a03e9045959e606a21822641ac' }]),
    nat('retail_sales_ytd_cny_100m', 'M', 'level', [{ cid: 'd0cb882c7f27443ab6b3ef9421901961', ind: '260a1794443b43dd93a59928b12f38af' }]),
    nat('retail_sales_yoy_pct', 'M', 'pct_change_yoy', [{ cid: 'd0cb882c7f27443ab6b3ef9421901961', ind: 'aaac57d54d2e465d91bc9f3ea1a8618e' }]),
    nat('retail_sales_ytd_yoy_pct', 'M', 'pct_change_yoy', [{ cid: 'd0cb882c7f27443ab6b3ef9421901961', ind: 'e3ca151b53d347b78d1e179e5ebf1d33' }]),
  ],
  fixed_asset_investment: [
    nat('fai_ytd_yoy_pct', 'M', 'pct_change_yoy', [{ cid: '5129067b149d4ddfbec1ffc478d35bfb', ind: '7e570cf8071c4734a7d78d9f0a70fbe1' }]),
    prov('fai_ytd_yoy_pct', 'M', 'pct_change_yoy', [{ cid: 'e43af1a71b2d4a768569866795ed66e2', ind: '31c20d4e16564c39a3e4d2cc0d2d83bb' }]),
  ],
  urban_unemployment: [
    nat('surveyed_urban_unemployment_rate_pct', 'M', 'rate_pct', [{ cid: 'ee3b7046b390415b9b7745e3d16f6052', ind: '3888eac6062945a79c8a27e5f13d4953' }]),
  ],
  capacity_utilization: [
    nat('industrial_capacity_utilization_single_quarter_pct', 'Q', 'level_pct', [{ cid: '56a7def4ab0749d8800eab2415f90b54', ind: '57ae79552303418087eee8f4f35b4368' }]),
    nat('industrial_capacity_utilization_change_vs_prior_year_quarter_pp', 'Q', 'change_pp', [{ cid: '56a7def4ab0749d8800eab2415f90b54', ind: 'f61308a73f854a55b7ab894e9e5f0e4c' }]),
    nat('industrial_capacity_utilization_ytd_pct', 'Q', 'level_pct', [{ cid: '56a7def4ab0749d8800eab2415f90b54', ind: 'a38b49d917e2453a92b9dc59d1b1d0c6' }]),
  ],
};

/** Indicators only the direct NBS route serves (the Eastmoney route has none). */
export const NBS_ONLY_INDICATORS = ['urban_unemployment', 'capacity_utilization'];

export const NBS_LABELS: Record<string, string> = {
  urban_unemployment: 'Surveyed urban unemployment rate',
  capacity_utilization: 'Industrial capacity utilisation (quarterly)',
};

// ── Regions ─────────────────────────────────────────────────────────

/** The 31 mainland provincial-level regions: GB code, Chinese name as the
 * platform spells it, English name. Taiwan, Hong Kong and Macao are in the
 * platform's region list but carry no value in these series. */
const REGIONS: Array<[string, string, string]> = [
  ['110000000000', '北京市', 'Beijing'], ['120000000000', '天津市', 'Tianjin'], ['130000000000', '河北省', 'Hebei'],
  ['140000000000', '山西省', 'Shanxi'], ['150000000000', '内蒙古自治区', 'Inner Mongolia'], ['210000000000', '辽宁省', 'Liaoning'],
  ['220000000000', '吉林省', 'Jilin'], ['230000000000', '黑龙江省', 'Heilongjiang'], ['310000000000', '上海市', 'Shanghai'],
  ['320000000000', '江苏省', 'Jiangsu'], ['330000000000', '浙江省', 'Zhejiang'], ['340000000000', '安徽省', 'Anhui'],
  ['350000000000', '福建省', 'Fujian'], ['360000000000', '江西省', 'Jiangxi'], ['370000000000', '山东省', 'Shandong'],
  ['410000000000', '河南省', 'Henan'], ['420000000000', '湖北省', 'Hubei'], ['430000000000', '湖南省', 'Hunan'],
  ['440000000000', '广东省', 'Guangdong'], ['450000000000', '广西壮族自治区', 'Guangxi'], ['460000000000', '海南省', 'Hainan'],
  ['500000000000', '重庆市', 'Chongqing'], ['510000000000', '四川省', 'Sichuan'], ['520000000000', '贵州省', 'Guizhou'],
  ['530000000000', '云南省', 'Yunnan'], ['540000000000', '西藏自治区', 'Tibet'], ['610000000000', '陕西省', 'Shaanxi'],
  ['620000000000', '甘肃省', 'Gansu'], ['630000000000', '青海省', 'Qinghai'], ['640000000000', '宁夏回族自治区', 'Ningxia'],
  ['650000000000', '新疆维吾尔自治区', 'Xinjiang'],
];
const ALL_REGION_ARGS = REGIONS.map(([value, text]) => ({ text, value }));

export function resolveRegion(input: string): { code: string; cn: string; en: string } | null {
  const q = input.trim().toLowerCase();
  if (!q) return null;
  for (const [code, cn, en] of REGIONS) {
    if (en.toLowerCase() === q || cn === input.trim() || cn.replace(/(省|市|自治区|壮族|回族|维吾尔)/g, '') === input.trim() || code === q) {
      return { code, cn, en };
    }
  }
  return null;
}

export function regionNames(): string[] {
  return REGIONS.map((r) => r[2]);
}

// ── Label classification ────────────────────────────────────────────

export interface Basis {
  status: 'established' | 'unresolved';
  measure: string | null;
  period_type: string | null;
  unit: string | null;
  base: string | null;
  published_unit: string | null;
  reason: string | null;
}

/** Read period type, measure, unit and base from an indicator's own label.
 * Returns status "unresolved" (and nulls) when the label cannot be read or
 * contradicts the series table; it never falls back to a guess. */
export function classifyLabel(label: string, publishedUnit: string | null, freq: Freq, expect: string): Basis {
  const l = label.replace(/\s+/g, '');
  const unresolved = (reason: string): Basis => ({ status: 'unresolved', measure: null, period_type: null, unit: null, base: null, published_unit: publishedUnit, reason });

  let base: string | null = null;
  if (l.includes('(上年同月=100)')) base = 'same month of the prior year = 100';
  else if (l.includes('(上年同期=100)')) base = 'same period of the prior year = 100';
  else if (l.includes('(上月=100)')) base = 'prior month = 100';

  let periodType: string | null;
  if (l.includes('累计')) periodType = 'year_to_date';
  else if (l.includes('当季值')) periodType = 'single_quarter';
  else if (l.includes('当期值')) periodType = 'single_month';
  else periodType = freq === 'M' ? 'single_month' : 'single_quarter';

  let measure: string | null = null;
  let unit: string | null = null;
  if (l.includes('百分点')) {
    measure = 'change_pp';
    unit = 'percentage points';
    // "change vs the same period of the prior year" is the label's meaning.
    if (!l.includes('比上年同期')) return unresolved('label names percentage points but not the comparison period');
  } else if (l.includes('环比增长') || l.includes('环比增减')) {
    measure = 'pct_change_qoq';
    unit = 'percent';
  } else if (/同比增长|同比增减|累计增长/.test(l)) {
    measure = 'pct_change_yoy';
    unit = 'percent';
  } else if (base) {
    measure = 'index';
    unit = 'index (base = 100)';
  } else if (/采购经理指数|商务活动指数|PMI产出指数/.test(l)) {
    measure = 'diffusion_index';
    unit = 'index points (50 = no change from the prior month)';
    base = '50 = no change from the prior month';
  } else if (l.includes('失业率')) {
    measure = 'rate_pct';
    unit = 'percent';
  } else if (l.includes('产能利用率')) {
    measure = 'level_pct';
    unit = 'percent';
  } else if (/\(亿元\)/.test(l)) {
    measure = 'level';
    unit = 'CNY 100 million';
  } else {
    return unresolved('label carries no recognisable base, change convention or unit');
  }

  if (measure !== expect) {
    return unresolved(`label reads as "${measure}" but the series table expects "${expect}"`);
  }
  return { status: 'established', measure, period_type: periodType, unit, base, published_unit: publishedUnit, reason: null };
}

// ── Periods ─────────────────────────────────────────────────────────

/** "202609MM" -> "2026-09"; "202603SS" -> "2026-Q3". */
export function periodFromCode(code: string): string | null {
  let m = code.match(/^(\d{4})(\d{2})MM$/);
  if (m) return `${m[1]}-${m[2]}`;
  m = code.match(/^(\d{4})(\d{2})SS$/);
  if (m) return `${m[1]}-Q${Number(m[2])}`;
  return null;
}

/** "2026-09" -> "202609MM"; "2026-Q3" -> "202603SS"; null if malformed. */
export function codeFromPeriod(p: string, freq: Freq): string | null {
  const s = p.trim().toUpperCase();
  if (freq === 'M') {
    const m = s.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    return m ? `${m[1]}${m[2]}MM` : null;
  }
  const q = s.match(/^(\d{4})-Q([1-4])$/);
  return q ? `${q[1]}0${q[2]}SS` : null;
}

function shift(code: string, back: number): string {
  const y = Number(code.slice(0, 4));
  const n = Number(code.slice(4, 6));
  if (code.endsWith('MM')) {
    const idx = y * 12 + (n - 1) - back;
    return `${Math.floor(idx / 12)}${String((idx % 12) + 1).padStart(2, '0')}MM`;
  }
  const idx = y * 4 + (n - 1) - back;
  return `${Math.floor(idx / 4)}0${(idx % 4) + 1}SS`;
}

function currentCode(freq: Freq, now = new Date()): string {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  return freq === 'M' ? `${y}${String(mo + 1).padStart(2, '0')}MM` : `${y}0${Math.floor(mo / 3) + 1}SS`;
}

// ── Platform calls ──────────────────────────────────────────────────

interface EsValue {
  value?: string;
  i_showname?: string;
  du_name?: string;
  _id?: string;
}
interface EsPeriod {
  code: string;
  name?: string;
  values: EsValue[];
}

async function esData(body: Record<string, unknown>, what: string): Promise<EsPeriod[]> {
  const res = await fetchWithTimeout(
    `${NBS_BASE}/stream/esData`,
    {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    },
    `${SOURCE_NAME} (${what})`,
  );
  if (!res.ok) throw await httpError(res, `${SOURCE_NAME} (${what})`);
  const j = (await res.json()) as { success?: boolean; message?: string; data?: EsPeriod[] };
  if (j.success === false) throw new Error(`${SOURCE_NAME} error: ${j.message ?? 'unknown'} (${what})`);
  return Array.isArray(j.data) ? j.data : [];
}

function rootFor(def: NbsSeriesDef): string {
  if (def.scope === 'national') return def.freq === 'M' ? ROOT_MONTHLY : ROOT_QUARTERLY;
  return def.freq === 'M' ? ROOT_PROV_MONTHLY : ROOT_PROV_QUARTERLY;
}

function toNumber(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export interface Observation {
  period: string;
  period_code: string;
  value: number | null;
  value_raw?: string;
}

export interface SeriesResult {
  series_id: string;
  label_cn: string | null;
  frequency: 'monthly' | 'quarterly';
  period_type: string | null;
  measure: string | null;
  unit: string | null;
  published_unit: string | null;
  base: string | null;
  basis_status: 'established' | 'unresolved';
  basis_note: string | null;
  latest: Observation | null;
  history: Observation[];
  blank_periods_dropped: number;
}

/** Fetch one series for one region (national = 全国) across its catalog nodes. */
async function fetchSeries(def: NbsSeriesDef, das: Array<{ text: string; value: string }>, periods: number, endCode: string): Promise<SeriesResult> {
  const obs: Observation[] = [];
  let label: string | null = null;
  let unit: string | null = null;
  let blanks = 0;
  const back = def.freq === 'M' ? periods + 5 : periods + 3;

  for (let i = 0; i < def.epochs.length && obs.length < periods; i++) {
    const ep = def.epochs[i];
    // An older node owns periods up to its end year only.
    let hi = endCode;
    if (ep.endYear != null) {
      const cap = def.freq === 'M' ? `${ep.endYear}12MM` : `${ep.endYear}04SS`;
      if (obs.length > 0) {
        // continue from just before the earliest period already collected
        hi = shift(obs[obs.length - 1].period_code, 1);
      }
      if (hi > cap) hi = cap;
    }
    const lo = shift(hi, back);
    const rows = await esData(
      { cid: ep.cid, indicatorIds: [ep.ind], daCatalogId: '', das, showType: '1', dts: [`${lo}-${hi}`], rootId: rootFor(def) },
      `${def.id}`,
    );
    for (const p of rows) {
      const v = p.values.find((x) => x._id === ep.ind) ?? p.values[0];
      if (v && label == null) {
        label = typeof v.i_showname === 'string' ? v.i_showname : null;
        unit = typeof v.du_name === 'string' ? v.du_name : null;
      }
      const per = periodFromCode(p.code);
      const n = v ? toNumber(v.value) : null;
      if (per == null || n == null) {
        blanks++;
        continue;
      }
      if (!obs.some((o) => o.period_code === p.code)) obs.push({ period: per, period_code: p.code, value: n });
    }
    obs.sort((a, b) => (a.period_code < b.period_code ? 1 : -1));
  }

  const kept = obs.slice(0, periods);
  const basis = label
    ? classifyLabel(label, unit, def.freq, def.expect)
    : ({ status: 'unresolved', measure: null, period_type: null, unit: null, base: null, published_unit: unit, reason: 'the platform returned no indicator label' } as Basis);
  return shapeResult(def, label, basis, kept, blanks);
}

function shapeResult(def: NbsSeriesDef, label: string | null, basis: Basis, kept: Observation[], blanks: number): SeriesResult {
  // An unresolved series keeps its number only as value_raw so nothing downstream reads it as a typed value.
  const history =
    basis.status === 'established'
      ? kept
      : kept.map((o) => ({ period: o.period, period_code: o.period_code, value: null, value_raw: String(o.value) }));
  return {
    series_id: def.id,
    label_cn: label ? label.trim() : null,
    frequency: def.freq === 'M' ? 'monthly' : 'quarterly',
    period_type: basis.period_type,
    measure: basis.measure,
    unit: basis.unit,
    published_unit: basis.published_unit,
    base: basis.base,
    basis_status: basis.status,
    basis_note: basis.reason,
    latest: history[0] ?? null,
    history,
    blank_periods_dropped: blanks,
  };
}

const NATIONAL_DAS = [{ text: '全国', value: '000000000000' }];

function clampPeriods(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 36) : 12;
}

/** Latest period (code) for which the first epoch of `def` holds a value for `das`. */
async function latestCode(def: NbsSeriesDef, das: Array<{ text: string; value: string }>): Promise<string | null> {
  const ep = def.epochs[0];
  const hi = currentCode(def.freq);
  const lo = shift(hi, def.freq === 'M' ? 6 : 4);
  const rows = await esData(
    { cid: ep.cid, indicatorIds: [ep.ind], daCatalogId: '', das, showType: '1', dts: [`${lo}-${hi}`], rootId: rootFor(def) },
    `${def.id} latest period`,
  );
  const sorted = rows.slice().sort((a, b) => (a.code < b.code ? 1 : -1));
  for (const p of sorted) {
    const v = p.values.find((x) => x._id === ep.ind) ?? p.values[0];
    if (v && toNumber(v.value) != null) return p.code;
  }
  return null;
}

// ── Entry points ────────────────────────────────────────────────────

export async function nbsNational(indicator: string, periods: number, seriesFilter: string | null) {
  const all = (NBS_SERIES[indicator] ?? []).filter((d) => d.scope === 'national');
  const defs = seriesFilter ? all.filter((d) => d.id === seriesFilter) : all;
  if (defs.length === 0) {
    return {
      found: false,
      indicator,
      message: seriesFilter
        ? `Unknown series "${seriesFilter}" for ${indicator}. Valid series: ${all.map((d) => d.id).join(', ')}.`
        : `The National Bureau of Statistics route carries no national series for "${indicator}".`,
    };
  }
  const results = await Promise.all(
    defs.map((d) => fetchSeries(d, NATIONAL_DAS, periods, currentCode(d.freq))),
  );
  const populated = results.filter((r) => r.latest != null);
  if (populated.length === 0) {
    return { found: false, indicator, source: SOURCE_NAME, message: 'The National Bureau of Statistics database returned only blank values for this indicator right now; no data is being reported rather than empty fields.' };
  }
  const lead = populated[0];
  return {
    found: true,
    indicator,
    source: SOURCE_NAME,
    served_by: 'publisher database, read directly',
    region: 'China (national)',
    series: results,
    data_as_of: lead.latest?.period ?? null,
    note: 'Each series carries its own period, period type, unit and base exactly as published; they are never converted. A year_to_date value is cumulative from January (or Q1), not a single month/quarter. Blank periods are dropped, not returned as nulls.',
  };
}

export async function nbsRegional(indicator: string, region: string, periodArg: string | null, periods: number, seriesFilter: string | null) {
  const all = (NBS_SERIES[indicator] ?? []).filter((d) => d.scope === 'provincial');
  if (all.length === 0) {
    const supported = Object.keys(NBS_SERIES).filter((k) => NBS_SERIES[k].some((d) => d.scope === 'provincial'));
    return { found: false, indicator, message: `No provincial series for "${indicator}". Provincial indicators: ${supported.join(', ')}.` };
  }
  const defs = seriesFilter ? all.filter((d) => d.id === seriesFilter) : all;
  if (defs.length === 0) {
    return { found: false, indicator, message: `Unknown provincial series "${seriesFilter}" for ${indicator}. Valid series: ${all.map((d) => d.id).join(', ')}.` };
  }

  if (region.trim().toLowerCase() !== 'all') {
    const r = resolveRegion(region);
    if (!r) return { found: false, indicator, message: `Unknown region "${region}". Use "all" or one of: ${regionNames().join(', ')}.` };
    const das = [{ text: r.cn, value: r.code }];
    const results = await Promise.all(defs.map((d) => fetchSeries(d, das, periods, currentCode(d.freq))));
    const populated = results.filter((s) => s.latest != null);
    if (populated.length === 0) {
      return { found: false, indicator, region: r.en, source: SOURCE_NAME, message: 'Only blank values were returned for this region right now; nothing is reported rather than empty fields.' };
    }
    return {
      found: true,
      indicator,
      source: SOURCE_NAME,
      served_by: 'publisher database, read directly',
      region: r.en,
      region_cn: r.cn,
      region_code: r.code,
      series: results,
      data_as_of: populated[0].latest?.period ?? null,
      note: 'Values as published for the region; period type, unit and base are per series and are never converted.',
    };
  }

  // Cross-section: one period, every mainland region.
  const out = [];
  let asOf: string | null = null;
  for (const d of defs) {
    let code: string | null;
    if (periodArg) {
      code = codeFromPeriod(periodArg, d.freq);
      if (!code) return { found: false, indicator, message: `period "${periodArg}" is not valid for ${d.freq === 'M' ? 'a monthly' : 'a quarterly'} series (use ${d.freq === 'M' ? 'YYYY-MM' : 'YYYY-Qn'}).` };
    } else {
      code = await latestCode(d, [ALL_REGION_ARGS[0]]);
      if (!code) {
        out.push({ series_id: d.id, rows: [], rows_returned: 0, message: 'no non-blank period found' });
        continue;
      }
    }
    const ep = d.epochs[0];
    const rows = await esData(
      { cid: ep.cid, indicatorIds: [ep.ind], daCatalogId: '', das: ALL_REGION_ARGS, showType: '2', dts: [code], rootId: rootFor(d) },
      `${d.id} cross-section`,
    );
    let label: string | null = null;
    let unit: string | null = null;
    const regionRows: Array<{ region: string; region_cn: string; region_code: string; value: number | null; value_raw?: string }> = [];
    const blankRegions: string[] = [];
    for (const p of rows) {
      const v = p.values.find((x) => x._id === ep.ind) ?? p.values[0];
      if (v && label == null) {
        label = typeof v.i_showname === 'string' ? v.i_showname : null;
        unit = typeof v.du_name === 'string' ? v.du_name : null;
      }
      const reg = REGIONS.find((r) => r[0] === p.code);
      if (!reg) continue; // Taiwan / Hong Kong / Macao: no value in these series
      const n = v ? toNumber(v.value) : null;
      if (n == null) {
        blankRegions.push(reg[2]);
        continue;
      }
      regionRows.push({ region: reg[2], region_cn: reg[1], region_code: reg[0], value: n });
    }
    const basis = label ? classifyLabel(label, unit, d.freq, d.expect) : ({ status: 'unresolved', measure: null, period_type: null, unit: null, base: null, published_unit: unit, reason: 'the platform returned no indicator label' } as Basis);
    const shaped = basis.status === 'established' ? regionRows : regionRows.map((r) => ({ ...r, value: null, value_raw: String(r.value) }));
    const per = periodFromCode(code);
    if (asOf == null && per && regionRows.length > 0) asOf = per;
    out.push({
      series_id: d.id,
      label_cn: label ? label.trim() : null,
      period: per,
      period_code: code,
      frequency: d.freq === 'M' ? 'monthly' : 'quarterly',
      period_type: basis.period_type,
      measure: basis.measure,
      unit: basis.unit,
      published_unit: basis.published_unit,
      base: basis.base,
      basis_status: basis.status,
      basis_note: basis.reason,
      rows_returned: shaped.length,
      blank_regions: blankRegions,
      rows: shaped,
    });
  }
  const anyRows = out.some((s) => (s as { rows_returned?: number }).rows_returned);
  if (!anyRows) return { found: false, indicator, source: SOURCE_NAME, message: 'No region had a value for the requested period; nothing is reported rather than blanks.' };
  return {
    found: true,
    indicator,
    source: SOURCE_NAME,
    served_by: 'publisher database, read directly',
    region: 'all (31 mainland provincial-level regions)',
    cross_section: out,
    data_as_of: asOf,
    note: 'Taiwan, Hong Kong and Macao are not covered by these series and are omitted. A region with no value for the period is listed in blank_regions instead of being returned as null.',
  };
}

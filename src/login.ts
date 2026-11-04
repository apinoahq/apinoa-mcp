/**
 * `apinoa-mcp login`: gets an API key through the OAuth 2.0 device authorization grant (RFC 8628) and writes
 * it to a .env file as APINOA_API_KEY.
 *
 * The person opens apinoa's page, signs in and types the code shown here; this side polls the token endpoint
 * until they approve, cancel, or the code expires. The key is never printed: only its prefix and last four
 * characters.
 *
 * Everything the command touches comes in through `LoginIO`, so it runs in tests without a terminal, a
 * network or a browser; cli.ts passes the real ones.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export interface LoginIO {
  /** The arguments after `login`. */
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds, like Date.now. */
  now: () => number;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** Whether stdout is a terminal. The browser is opened only when it is. */
  isTTY: boolean;
  openBrowser: (url: string) => void;
}

const DEFAULT_API = "https://api.apinoa.com";
const CLIENT_ID = "apinoa-cli";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const KEY_NAME = "APINOA_API_KEY";
const KEY_PREFIX = "apinoa_mcp_";
const MAX_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const AGAIN = "Run `npx apinoa-mcp login` again.";
const DASHBOARD = "Dashboard → API keys at apinoa.com";
// RFC 6750 b64token: what a bearer token may contain. Anything else (a newline above all) could add lines to .env.
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

const USAGE = `Usage: npx apinoa-mcp login [--out <path>] [--no-browser]

Signs in to apinoa in your browser and saves a new API key to .env as ${KEY_NAME}.

  --out <path>       Write the key to this file instead of .env in the current folder
  --no-browser       Print the address without opening it
  -h, --help         Show this help
`;

/** Runs `login` and returns the process exit code: 0 once a key is saved, 1 otherwise. */
export async function login(io: LoginIO): Promise<number> {
  const out = (line = "") => void io.stdout.write(line + "\n");
  const fail = (line: string) => {
    io.stderr.write(line + "\n");
    return 1;
  };

  const args = parseArgs(io.argv);
  if ("error" in args) {
    io.stderr.write(`${args.error}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    io.stdout.write(USAGE);
    return 0;
  }

  const base = apiBase(io.env.APINOA_API_URL);
  if (!base) return fail(`APINOA_API_URL must be an https:// address (http:// only for localhost): ${clean(io.env.APINOA_API_URL ?? "")}`);

  const file = resolve(io.cwd, args.envFile ?? ".env");
  const shown = display(io.cwd, file);
  // Before a key exists, so a file that cannot be written does not leave one behind.
  const unwritable = await cannotWrite(file, shown);
  if (unwritable) return fail(unwritable);

  // Step 1: a device code and the code the person types.
  let start: Answer;
  try {
    start = await post(io, `${base}/oauth/device_authorization`, { client_id: CLIENT_ID, scope: "apinoa" });
  } catch (err) {
    return fail(`Could not reach ${base} (${reason(err)}).`);
  }
  if (start.status !== 200) {
    const busy = start.status === 429 || start.status >= 500;
    return fail(`apinoa could not start a sign-in (${describe(start)}).${busy ? " Try again in a minute." : ""}`);
  }
  const grant = start.body ?? {};
  const deviceCode = typeof grant.device_code === "string" ? grant.device_code : "";
  const userCode = typeof grant.user_code === "string" ? clean(grant.user_code).slice(0, 64) : "";
  const page = typeof grant.verification_uri === "string" ? parseUrl(grant.verification_uri) : undefined;
  if (!deviceCode || !userCode || !page || !/^https?:$/.test(page.protocol)) {
    return fail("apinoa answered the sign-in request with something this version does not understand. Update apinoa-mcp and try again.");
  }
  const expiresIn = positive(grant.expires_in) ?? 600;
  let interval = (positive(grant.interval) ?? 5) * 1000;
  const deadline = io.now() + expiresIn * 1000;
  const ours = page.origin === new URL(base).origin;

  out("To create an API key, open this page:");
  out();
  out(`  ${clean(page.href)}`);
  out();
  out("and enter the code:");
  out();
  out(`  ${userCode}`);
  out();
  out("Enter it only on that apinoa page, and only because you started this yourself. Anyone else who asks you to enter a code is trying to get into your account.");
  out();
  if (!ours) {
    io.stderr.write(`Warning: that address is not on ${new URL(base).origin}. Check it before you visit it.\n`);
  } else if (io.isTTY && !io.env.CI && !args.noBrowser) {
    io.openBrowser(page.href);
    out("Opening it in your browser…");
  }
  out("Waiting for approval…");

  // Step 2: poll until the person approves or cancels, or the code expires.
  let wait = interval;
  let lastProblem = "";
  for (;;) {
    const left = deadline - io.now();
    if (left <= wait) {
      if (left > 0) await io.sleep(left);
      return fail(`The code expired.${lastProblem ? ` The last attempt to reach apinoa failed (${lastProblem}).` : ""} ${AGAIN}`);
    }
    await io.sleep(wait);

    let answer: Answer;
    try {
      answer = await post(io, `${base}/oauth/token`, { grant_type: GRANT_TYPE, device_code: deviceCode, client_id: CLIENT_ID });
    } catch (err) {
      lastProblem = reason(err);
      wait = Math.min(Math.max(wait, 1000) * 2, MAX_BACKOFF_MS);
      continue;
    }
    if (answer.status === 429 || answer.status >= 500) {
      lastProblem = `HTTP ${answer.status}`;
      wait = Math.min(Math.max(wait, 1000) * 2, MAX_BACKOFF_MS);
      continue;
    }
    lastProblem = "";

    if (answer.status !== 200) {
      const error = answer.body?.error;
      if (error === "authorization_pending") {
        wait = interval;
        continue;
      }
      if (error === "slow_down") {
        interval += 5000;
        wait = interval;
        continue;
      }
      if (error === "access_denied") return fail("The sign-in was cancelled, so no key was created.");
      if (error === "expired_token") return fail(`The code expired. ${AGAIN}`);
      return fail(`apinoa refused the sign-in (${describe(answer)}). ${AGAIN}`);
    }

    const token = answer.body ?? {};
    const key = token.access_token;
    if (typeof key !== "string" || !TOKEN.test(key)) {
      return fail("apinoa approved the sign-in but answered with a key this version cannot save. Update apinoa-mcp and try again.");
    }
    return saved(io, file, shown, key, token);
  }
}

/** Writes the key, says where it went, and warns when the file is not ignored by git. */
async function saved(io: LoginIO, file: string, shown: string, key: string, body: Record<string, unknown>): Promise<number> {
  const masked = maskKey(key);
  let how: "created" | "replaced" | "added";
  try {
    how = await saveKey(file, key);
  } catch (err) {
    io.stderr.write(`Could not save the key to ${shown} (${reason(err)}). Revoke it (${masked}) in ${DASHBOARD}, then run \`npx apinoa-mcp login\` again.\n`);
    return 1;
  }
  const lines = [`Approved. The key (${masked}) is saved in ${shown} as ${KEY_NAME}${how === "replaced" ? ", replacing the one that was there" : ""}.`];
  const seconds = positive(body.expires_in);
  const days = seconds === undefined ? undefined : seconds >= 86_400 ? Math.round(seconds / 86_400) : 0;
  const expiry = days === undefined ? "" : days === 0 ? "It expires in less than a day. " : `It expires in ${days} day${days === 1 ? "" : "s"}. `;
  lines.push(`${expiry}It is listed in ${DASHBOARD}, where you can revoke it.`);
  const credit = creditUsd(body.apinoa_credit_usd);
  if (credit) lines.push(`Your account received $${credit} of evaluation credit.`);
  const revoked = revokedKeys(body.apinoa_revoked_keys);
  if (revoked.length) {
    lines.push(
      `apinoa keeps a few CLI keys per account, so this sign-in revoked the oldest (${revoked.map((p) => `${p}…`).join(", ")}). A project still using ${revoked.length === 1 ? "it" : "them"} needs \`npx apinoa-mcp login\` again.`,
    );
  }
  io.stdout.write(lines.join("\n") + "\n");
  if ((await gitIgnored(file)) === false) {
    io.stderr.write(`Warning: ${shown} is not ignored by git. Add it to .gitignore so the key is never committed.\n`);
  }
  if (process.platform !== "win32") {
    const mode = await stat(file).then((s) => s.mode & 0o777, () => undefined);
    if (mode !== undefined && mode & 0o077) {
      io.stderr.write(`Warning: other users on this computer can read ${shown} (mode ${mode.toString(8)}). Run \`chmod 600 ${shown}\`.\n`);
    }
  }
  return 0;
}

type Args = { envFile?: string; noBrowser: boolean; help: boolean } | { error: string };

function parseArgs(argv: string[]): Args {
  const args = { envFile: undefined as string | undefined, noBrowser: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--no-browser") args.noBrowser = true;
    // Not --env-file: Node reads that flag anywhere on the command line, past the script name, and
    // exits before this runs when the file does not exist yet (or loads it into this process when it does).
    else if (a === "--out" || a.startsWith("--out=")) {
      const value = a === "--out" ? argv[++i] : a.slice("--out=".length);
      if (!value) return { error: "--out needs a path." };
      args.envFile = value;
    } else return { error: `Unknown option: ${clean(a)}` };
  }
  return args;
}

/** The API's base URL, or undefined when it is not https (http is allowed for this machine only). */
function apiBase(value: string | undefined): string | undefined {
  const raw = value?.trim() || DEFAULT_API;
  const url = parseUrl(raw);
  if (!url) return undefined;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
  return raw.replace(/\/+$/, "");
}

interface Answer {
  status: number;
  body: Record<string, unknown> | undefined;
}

async function post(io: LoginIO, url: string, form: Record<string, string>): Promise<Answer> {
  const res = await io.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "apinoa-mcp" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body: body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined };
}

/** An RFC 6749 error answer as `code: description`, or the HTTP status when it is not one. */
function describe(a: Answer): string {
  const code = typeof a.body?.error === "string" ? clean(a.body.error).slice(0, 80) : `HTTP ${a.status}`;
  const text = typeof a.body?.error_description === "string" ? clean(a.body.error_description).slice(0, 300) : "";
  return text ? `${code}: ${text}` : code;
}

/** `apinoa_mcp_…3f9a`: enough to tell keys apart in the dashboard, never enough to use one. */
export function maskKey(key: string): string {
  const tail = key.length >= 12 ? key.slice(-4) : "";
  return `${key.startsWith(KEY_PREFIX) ? KEY_PREFIX : ""}…${tail}`;
}

/**
 * The .env text with every APINOA_API_KEY line (also `export APINOA_API_KEY=`) set to the key, and every other
 * line and line ending untouched; with none, one line is appended in the file's own line-ending style. The
 * text is read and written as latin1, so bytes that are not UTF-8 survive.
 */
export function setEnvKey(text: string, key: string): { text: string; replaced: number } {
  const eol = text.match(/\r?\n/)?.[0] ?? "\n";
  const line = new RegExp(`^((?:\\xEF\\xBB\\xBF)?[ \\t]*)(export[ \\t]+)?${KEY_NAME}[ \\t]*=`);
  let replaced = 0;
  const chunks = text.split(/(?<=\n)/).map((chunk) => {
    const end = chunk.endsWith("\r\n") ? "\r\n" : chunk.endsWith("\n") ? "\n" : "";
    const m = line.exec(chunk.slice(0, chunk.length - end.length));
    if (!m) return chunk;
    replaced++;
    return `${m[1]}${m[2] ? "export " : ""}${KEY_NAME}=${key}${end}`;
  });
  if (replaced) return { text: chunks.join(""), replaced };
  const sep = text === "" || text.endsWith("\n") ? "" : eol;
  return { text: `${text}${sep}${KEY_NAME}=${key}${eol}`, replaced };
}

async function saveKey(file: string, key: string): Promise<"created" | "replaced" | "added"> {
  let before: string | undefined;
  try {
    before = await readFile(file, "latin1");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (before === undefined) {
    await writeFile(file, `${KEY_NAME}=${key}\n`, { encoding: "latin1", mode: 0o600, flag: "wx" });
    await chmod(file, 0o600).catch(() => {});
    return "created";
  }
  const next = setEnvKey(before, key);
  await writeFile(file, next.text, "latin1");
  return next.replaced ? "replaced" : "added";
}

/** Why the key could not be written to `file`, checked before one is created; undefined when it can. */
async function cannotWrite(file: string, shown: string): Promise<string | undefined> {
  try {
    if (!(await stat(file)).isFile()) return `${shown} is not a file.`;
    await access(file, constants.R_OK | constants.W_OK);
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return `Cannot write ${shown} (${code ?? reason(err)}).`;
  }
  try {
    if (!(await stat(dirname(file))).isDirectory()) throw new Error("not a folder");
    await access(dirname(file), constants.W_OK);
    return undefined;
  } catch {
    return `Cannot create ${shown}: its folder does not exist or cannot be written to.`;
  }
}

/** The display prefixes of the keys the server says this sign-in revoked (apinoa_revoked_keys), safe to print. */
export function revokedKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && /^[A-Za-z0-9_]{1,64}$/.test(v)).slice(0, 10);
}

/**
 * true when git ignores the file, false when it does not, undefined when git cannot tell (no git, no
 * repository). A symlinked .env is checked at both ends: git ignoring the link says nothing about the file
 * it points to, which may sit in a repository of its own.
 */
async function gitIgnored(file: string): Promise<boolean | undefined> {
  const here = await checkIgnore(file);
  const real = await realpath(file).catch(() => file);
  if (real === file) return here;
  const there = await checkIgnore(real);
  if (here === false || there === false) return false;
  return here ?? there;
}

function checkIgnore(file: string): Promise<boolean | undefined> {
  return new Promise((done) => {
    try {
      const child = spawn("git", ["check-ignore", "-q", "--", basename(file)], { cwd: dirname(file), stdio: "ignore", timeout: 10_000 });
      child.on("error", () => done(undefined));
      child.on("close", (code) => done(code === 0 ? true : code === 1 ? false : undefined));
    } catch {
      done(undefined);
    }
  });
}

/** Opens a URL in the default browser without a shell; failures are ignored (the address is printed anyway). */
export function openInBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") [cmd, args] = ["open", [url]];
  else if (process.platform === "win32") {
    // cmd reads its own command line, so a character it treats specially is not passed to it at all.
    if (/[&|<>^%!"\s]/.test(url)) return;
    [cmd, args] = ["cmd", ["/c", "start", "", url]];
  } else [cmd, args] = ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The address is on screen; opening it is a convenience.
  }
}

function creditUsd(value: unknown): string | undefined {
  const text = typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : typeof value === "string" ? value.trim() : "";
  return /^\d{1,9}(\.\d{1,6})?$/.test(text) && Number(text) > 0 ? text : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** A path as typed relative to the folder the command ran in, or absolute when it is outside it. */
function display(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}

function reason(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError") return "timed out";
  return clean(e?.cause?.code ?? e?.code ?? e?.cause?.message ?? e?.message ?? String(err)).slice(0, 200);
}

/** Text from elsewhere, without control characters, so it cannot move the cursor or recolour the terminal. */
function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

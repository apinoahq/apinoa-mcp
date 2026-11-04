// `apinoa-mcp login` (RFC 8628 device authorization grant): the flow with fetch, the clock and the browser
// injected, then the real CLI end to end against a local server, and the stdio server still starting without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { login, maskKey, setEnvKey } from "../dist/login.js";

const KEY = "apinoa_mcp_0123456789abcdef0123456789abcdef";
const SHOWN = "apinoa_mcp_…cdef";
// Never contacted: fetch is faked for every test but the end-to-end ones, which run their own server.
const BASE = "http://127.0.0.1:4100";
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const POSIX = process.platform !== "win32";

const tmp = () => mkdtemp(join(tmpdir(), "apinoa-login-"));
const pending = [400, { error: "authorization_pending" }];
const slowDown = [400, { error: "slow_down" }];
const approved = (extra = {}) => [200, { access_token: KEY, token_type: "Bearer", scope: "apinoa", expires_in: 7_776_000, ...extra }];
const device = (extra = {}) => [200, { device_code: "dc_secret", user_code: "BCDF-GHJK", verification_uri: `${BASE}/oauth/device`, expires_in: 600, interval: 5, ...extra }];
const offline = () => {
  throw new TypeError("fetch failed");
};

/**
 * Runs login with a fake API: `start` answers the device authorization request, `token` lists the token
 * endpoint's answers in order (the last one repeats). An answer is [status, body] or a function returning one.
 */
async function run({ token = [approved()], start = device(), argv = [], env = { APINOA_API_URL: BASE }, cwd, isTTY = false, onApproved } = {}) {
  cwd ??= await tmp();
  const calls = [];
  const waits = [];
  const opened = [];
  const answers = [...token];
  let clock = 1_700_000_000_000;
  let out = "";
  let err = "";
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method, headers: init.headers, body: init.body });
    let answer = u.pathname === "/oauth/device_authorization" ? start : u.pathname === "/oauth/token" ? (answers.length > 1 ? answers.shift() : answers[0]) : [404, {}];
    if (typeof answer === "function") answer = answer();
    const [status, body] = answer;
    if (status === 200 && body.access_token) onApproved?.();
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const code = await login({
    argv,
    env,
    cwd,
    fetch,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
    isTTY,
    openBrowser: (url) => opened.push(url),
  });
  // The one rule every run keeps: the key never reaches the terminal, and neither does the device code.
  for (const text of [out, err]) {
    assert.ok(!text.includes(KEY) && !text.includes(KEY.slice(11, 31)), `the key leaked:\n${text}`);
    assert.ok(!text.includes("dc_secret"), "the device code leaked");
  }
  return { code, out, err, calls, waits, opened, cwd, polls: calls.filter((c) => c.url.pathname === "/oauth/token").length };
}

const exists = (f) => stat(f).then(() => true, () => false);

test("pending, pending, approved: a new .env holds the key, readable by its owner only", async () => {
  const r = await run({ token: [pending, pending, approved()] });
  assert.equal(r.code, 0, r.err);
  const file = join(r.cwd, ".env");
  assert.equal(await readFile(file, "utf8"), `APINOA_API_KEY=${KEY}\n`);
  if (POSIX) assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(r.polls, 3);
  assert.deepEqual(r.waits, [5000, 5000, 5000]);
  assert.match(r.out, new RegExp(`  ${BASE}/oauth/device\n`));
  assert.match(r.out, /  BCDF-GHJK\n/);
  assert.match(r.out, /only on that apinoa page, and only because you started this yourself/);
  assert.match(r.out, /Waiting for approval…/);
  assert.ok(r.out.includes(`(${SHOWN}) is saved in .env as APINOA_API_KEY.`), r.out);
  assert.match(r.out, /It expires in 90 days\. It is listed in Dashboard → API keys at apinoa\.com, where you can revoke it\./);
  assert.doesNotMatch(r.out + r.err, /credit/i, "no credit line without apinoa_credit_usd");
});

test("the requests are form-encoded, from client apinoa-cli, with the device code grant", async () => {
  const r = await run({ token: [pending, approved()] });
  const [start, poll] = r.calls;
  assert.equal(start.url.href, `${BASE}/oauth/device_authorization`);
  assert.equal(start.method, "POST");
  assert.equal(start.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(start.body, "client_id=apinoa-cli&scope=apinoa");
  assert.equal(poll.url.href, `${BASE}/oauth/token`);
  assert.equal(poll.method, "POST");
  assert.equal(poll.headers["content-type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(poll.body);
  assert.deepEqual([...form.keys()].sort(), ["client_id", "device_code", "grant_type"]);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(form.get("device_code"), "dc_secret");
  assert.equal(form.get("client_id"), "apinoa-cli");
});

test("an existing .env keeps every other line and its CRLF endings; each APINOA_API_KEY line is replaced, export kept", async () => {
  const cwd = await tmp();
  const file = join(cwd, ".env");
  const before = "FOO=1\r\n# APINOA_API_KEY=keep-me\r\n  export APINOA_API_KEY = old \r\nAPINOA_API_KEY_OLD=x\r\nAPINOA_API_KEY=old2\r\nBAR=2";
  await writeFile(file, before, { mode: 0o644 });
  const r = await run({ cwd });
  assert.equal(r.code, 0, r.err);
  assert.equal(await readFile(file, "utf8"), `FOO=1\r\n# APINOA_API_KEY=keep-me\r\n  export APINOA_API_KEY=${KEY}\r\nAPINOA_API_KEY_OLD=x\r\nAPINOA_API_KEY=${KEY}\r\nBAR=2`);
  if (POSIX) assert.equal((await stat(file)).mode & 0o777, 0o644, "an existing file keeps its mode");
  // ...but a mode others can read is pointed out.
  if (POSIX) assert.match(r.err, /other users on this computer can read \.env \(mode 644\)\. Run `chmod 600 \.env`/);
  assert.match(r.out, /replacing the one that was there/);
});

test("a .env only its owner can read gets no mode warning", async () => {
  const cwd = await tmp();
  await writeFile(join(cwd, ".env"), "FOO=1\n", { mode: 0o600 });
  const r = await run({ cwd });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /other users/);
});

test("an existing .env without the key gets one line appended, in its own line-ending style, bytes kept", async () => {
  const cwd = await tmp();
  const file = join(cwd, ".env");
  await writeFile(file, Buffer.from("X=\xff\nY=2", "latin1"));
  assert.equal((await run({ cwd })).code, 0);
  assert.deepEqual(await readFile(file), Buffer.from(`X=\xff\nY=2\nAPINOA_API_KEY=${KEY}\n`, "latin1"));
});

test("setEnvKey: replace, append and leave alone", () => {
  const k = "apinoa_mcp_new";
  assert.deepEqual(setEnvKey("", k), { text: `APINOA_API_KEY=${k}\n`, replaced: 0 });
  assert.deepEqual(setEnvKey("A=1\n", k), { text: `A=1\nAPINOA_API_KEY=${k}\n`, replaced: 0 });
  assert.deepEqual(setEnvKey("A=1\r\nB=2", k), { text: `A=1\r\nB=2\r\nAPINOA_API_KEY=${k}\r\n`, replaced: 0 });
  assert.deepEqual(setEnvKey("A=1\r\n", k), { text: `A=1\r\nAPINOA_API_KEY=${k}\r\n`, replaced: 0 });
  assert.deepEqual(setEnvKey("APINOA_API_KEY=a\nAPINOA_API_KEY=b\n", k), { text: `APINOA_API_KEY=${k}\nAPINOA_API_KEY=${k}\n`, replaced: 2 });
  assert.deepEqual(setEnvKey("export\tAPINOA_API_KEY=a", k), { text: `export APINOA_API_KEY=${k}`, replaced: 1 });
  assert.deepEqual(setEnvKey("\xEF\xBB\xBFAPINOA_API_KEY=a\n", k), { text: `\xEF\xBB\xBFAPINOA_API_KEY=${k}\n`, replaced: 1 }, "a UTF-8 BOM stays");
  const untouched = "#APINOA_API_KEY=a\nMY_APINOA_API_KEY=b\nAPINOA_API_KEYS=c\n";
  assert.deepEqual(setEnvKey(untouched, k), { text: `${untouched}APINOA_API_KEY=${k}\n`, replaced: 0 });
});

test("--out writes there, resolved against the working folder, and nothing to ./.env", async () => {
  const cwd = await tmp();
  await mkdir(join(cwd, "config"));
  const r = await run({ cwd, argv: ["--out", "config/dev.env"] });
  assert.equal(r.code, 0, r.err);
  assert.equal(await readFile(join(cwd, "config", "dev.env"), "utf8"), `APINOA_API_KEY=${KEY}\n`);
  assert.equal(await exists(join(cwd, ".env")), false);
  assert.ok(r.out.includes(`saved in ${join("config", "dev.env")} as`));

  const s = await run({ cwd, argv: ["--out=other.env"] });
  assert.equal(s.code, 0, s.err);
  assert.equal(await readFile(join(cwd, "other.env"), "utf8"), `APINOA_API_KEY=${KEY}\n`);
});

test("slow_down adds 5 seconds to this and every later wait", async () => {
  const r = await run({ token: [slowDown, pending, slowDown, approved()] });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.waits, [5000, 10000, 10000, 15000]);
});

test("Cancel in the browser, an expired code or another refusal stops with exit 1 and writes nothing", async () => {
  const denied = await run({ token: [pending, [400, { error: "access_denied" }]] });
  assert.equal(denied.code, 1);
  assert.match(denied.err, /The sign-in was cancelled, so no key was created\./);
  assert.equal(await exists(join(denied.cwd, ".env")), false);
  assert.equal(denied.polls, 2);

  const expired = await run({ token: [[400, { error: "expired_token" }]] });
  assert.equal(expired.code, 1);
  assert.match(expired.err, /The code expired\. Run `npx apinoa-mcp login` again\./);
  assert.equal(await exists(join(expired.cwd, ".env")), false);

  const refused = await run({ token: [[400, { error: "invalid_grant", error_description: "The device code is not valid." }]] });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /apinoa refused the sign-in \(invalid_grant: The device code is not valid\.\)/);
  assert.equal(await exists(join(refused.cwd, ".env")), false);

  const odd = await run({ token: [[200, { access_token: `${KEY}\nEVIL=1`, token_type: "Bearer" }]] });
  assert.equal(odd.code, 1, "a key that would add a line to .env is not written");
  assert.equal(await exists(join(odd.cwd, ".env")), false);
});

test("polling stops at the code's expires_in", async () => {
  const r = await run({ start: device({ expires_in: 12 }), token: [pending] });
  assert.equal(r.code, 1);
  assert.equal(r.polls, 2);
  assert.deepEqual(r.waits, [5000, 5000, 2000], "the last wait runs out the code, without a poll after it");
  assert.match(r.err, /The code expired\. Run `npx apinoa-mcp login` again\./);
  assert.equal(await exists(join(r.cwd, ".env")), false);
});

test("a 5xx, a 429 or no network backs off, doubling up to 60 s, and keeps polling", async () => {
  const busy = [503, { error: "temporarily_unavailable" }];
  const r = await run({ token: [busy, offline, [429, { error: "temporarily_unavailable" }], [502, "<html>bad gateway</html>"], busy, busy, pending, approved()] });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.waits, [5000, 10000, 20000, 40000, 60000, 60000, 60000, 5000]);
  assert.equal(await readFile(join(r.cwd, ".env"), "utf8"), `APINOA_API_KEY=${KEY}\n`);

  const down = await run({ start: device({ expires_in: 60 }), token: [busy] });
  assert.equal(down.code, 1);
  assert.match(down.err, /The code expired\. The last attempt to reach apinoa failed \(HTTP 503\)\. Run `npx apinoa-mcp login` again\./);
});

test("apinoa_revoked_keys: the revoked CLI keys are named by prefix; anything unprintable is dropped", async () => {
  const r = await run({ token: [approved({ apinoa_revoked_keys: ["apinoa_mcp_0123456789ab", "bad\nline", 7] })] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /revoked the oldest \(apinoa_mcp_0123456789ab…\)\. A project still using it needs `npx apinoa-mcp login` again\./);
  assert.doesNotMatch(r.out, /bad/);
  const none = await run({ token: [approved()] });
  assert.doesNotMatch(none.out, /revoked/);
});

test("apinoa_credit_usd is reported when present", async () => {
  const r = await run({ token: [approved({ apinoa_credit_usd: "0.10" })] });
  assert.equal(r.code, 0);
  assert.match(r.out, /Your account received \$0\.10 of evaluation credit\./);
});

test("the browser opens only on a terminal, outside CI, without --no-browser, and only on the API's own origin", async () => {
  const page = `${BASE}/oauth/device`;
  assert.deepEqual((await run({ isTTY: false })).opened, []);
  assert.deepEqual((await run({ isTTY: true, env: { APINOA_API_URL: BASE, CI: "true" } })).opened, []);
  assert.deepEqual((await run({ isTTY: true, argv: ["--no-browser"] })).opened, []);
  assert.deepEqual((await run({ isTTY: true, env: { APINOA_API_URL: BASE, CI: "" } })).opened, [page], "an empty CI counts as unset");
  const tty = await run({ isTTY: true });
  assert.deepEqual(tty.opened, [page]);
  assert.match(tty.out, /Opening it in your browser…/);

  const elsewhere = await run({ isTTY: true, start: device({ verification_uri: "https://apinoa.example/oauth/device" }) });
  assert.deepEqual(elsewhere.opened, []);
  assert.match(elsewhere.out, /https:\/\/apinoa\.example\/oauth\/device/, "still printed");
  assert.match(elsewhere.err, /Warning: that address is not on http:\/\/127\.0\.0\.1:4100\. Check it before you visit it\./);
  assert.equal(elsewhere.code, 0);
});

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

test("a .env that git does not ignore gets a warning; an ignored one does not", { skip: !hasGit && "git is not installed" }, async () => {
  const git = (cwd, ...args) => assert.equal(spawnSync("git", args, { cwd, stdio: "ignore" }).status, 0, `git ${args.join(" ")}`);
  const repo = async () => {
    const cwd = await tmp();
    const none = join(await tmp(), "no-excludes");
    await writeFile(none, "");
    git(cwd, "init", "-q");
    // The machine's global excludes (which often list .env) must not decide this test.
    git(cwd, "config", "core.excludesFile", none);
    return cwd;
  };

  const open = await run({ cwd: await repo() });
  assert.equal(open.code, 0);
  assert.match(open.err, /Warning: \.env is not ignored by git\. Add it to \.gitignore so the key is never committed\./);

  const ignored = await repo();
  await writeFile(join(ignored, ".gitignore"), ".env\n");
  const quiet = await run({ cwd: ignored });
  assert.equal(quiet.code, 0);
  assert.doesNotMatch(quiet.err, /gitignore/);

  const outside = await run();
  assert.doesNotMatch(outside.err, /gitignore/, "outside a repository there is nothing to warn about");
});

test("APINOA_API_URL must be https, or http on this machine; the default is api.apinoa.com", async () => {
  for (const url of ["http://example.com", "ftp://localhost", "not a url"]) {
    const r = await run({ env: { APINOA_API_URL: url } });
    assert.equal(r.code, 1, url);
    assert.equal(r.calls.length, 0, url);
    assert.match(r.err, /APINOA_API_URL must be an https:\/\/ address/);
  }
  for (const url of ["http://localhost:4100", "http://[::1]:4100/", "https://api.example.com"]) {
    const r = await run({ env: { APINOA_API_URL: url } });
    assert.equal(r.code, 0, `${url}: ${r.err}`);
    assert.equal(r.calls[0].url.href, `${url.replace(/\/$/, "")}/oauth/device_authorization`);
  }
  const fallback = await run({ env: {}, start: device({ verification_uri: "https://api.apinoa.com/oauth/device" }), isTTY: true });
  assert.equal(fallback.calls[0].url.href, "https://api.apinoa.com/oauth/device_authorization", "faked: no request leaves the machine");
  assert.deepEqual(fallback.opened, ["https://api.apinoa.com/oauth/device"]);
});

test("a sign-in apinoa will not start, or cannot be reached for, fails with one sentence", async () => {
  const busy = await run({ start: [429, { error: "temporarily_unavailable", error_description: "Too many sign-ins." }] });
  assert.equal(busy.code, 1);
  assert.match(busy.err, /apinoa could not start a sign-in \(temporarily_unavailable: Too many sign-ins\.\)\. Try again in a minute\./);
  assert.equal(busy.calls.length, 1);

  const down = await run({ start: offline });
  assert.equal(down.code, 1);
  assert.match(down.err, /Could not reach http:\/\/127\.0\.0\.1:4100/);

  const garbled = await run({ start: [200, { device_code: "dc_secret" }] });
  assert.equal(garbled.code, 1);
  assert.equal(garbled.calls.length, 1);
});

test("a file that cannot be written is refused before a key is created; one that fails after says how to revoke it", async () => {
  const cwd = await tmp();
  const missing = await run({ cwd, argv: ["--out", "nowhere/.env"] });
  assert.equal(missing.code, 1);
  assert.equal(missing.calls.length, 0);
  assert.match(missing.err, /Cannot create nowhere\/\.env|Cannot create nowhere\\\.env/);

  await mkdir(join(cwd, "folder"));
  const folder = await run({ cwd, argv: ["--out", "folder"] });
  assert.equal(folder.code, 1);
  assert.equal(folder.calls.length, 0);
  assert.match(folder.err, /folder is not a file\./);

  const late = join(cwd, "late.env");
  const after = await run({ cwd, argv: ["--out", late], onApproved: () => mkdirSync(late) });
  assert.equal(after.code, 1);
  assert.ok(after.err.includes(`Revoke it (${SHOWN}) in Dashboard → API keys at apinoa.com`), after.err);
});

test("--help prints the usage; an unknown option is refused; neither makes a request", async () => {
  const help = await run({ argv: ["--help"] });
  assert.equal(help.code, 0);
  assert.match(help.out, /^Usage: npx apinoa-mcp login \[--out <path>\] \[--no-browser\]/);
  assert.equal(help.calls.length, 0);

  const bad = await run({ argv: ["--bogus"] });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Unknown option: --bogus/);
  assert.equal(bad.calls.length, 0);

  const empty = await run({ argv: ["--out"] });
  assert.equal(empty.code, 1);
  assert.match(empty.err, /--out needs a path\./);
});

test("maskKey keeps the prefix and the last four characters only", () => {
  assert.equal(maskKey(KEY), SHOWN);
  assert.equal(maskKey("sk_live_abcdefghijklmnop"), "…mnop");
  assert.equal(maskKey("short"), "…");
});

// ---- the real CLI ----

/** Runs `node dist/cli.js ...args`, resolving with its exit code and output (killed after `ms`). */
function cli(args, { env, cwd, input, until, ms = 20_000 }) {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      failed(new Error(`timed out\nstdout: ${out}\nstderr: ${err}`));
    }, ms);
    const check = () => until?.(out, err) && child.kill();
    child.stdout.on("data", (d) => {
      out += d;
      check();
    });
    child.stderr.on("data", (d) => {
      err += d;
      check();
    });
    child.on("error", failed);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, out, err });
    });
    if (input) child.stdin.write(input);
    else child.stdin.end();
  });
}

/** The environment of this process without the variables a test sets itself. */
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ["APINOA_API_KEY", "APINOA_API_URL", "APINOA_BASE_URL", "APINOA_MCP_MODE"]) if (!(k in extra)) delete env[k];
  return env;
}

/** A local device-flow server: two pending answers, then a key with evaluation credit. */
async function deviceServer() {
  const seen = [];
  const state = { polls: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ path: req.url, type: req.headers["content-type"], body });
      const send = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
      if (req.method === "POST" && req.url === "/oauth/device_authorization") {
        return send(200, { device_code: "dc_e2e", user_code: "WXYZ-BCDF", verification_uri: `${base}/oauth/device`, expires_in: 30, interval: 0.05 });
      }
      if (req.method === "POST" && req.url === "/oauth/token") {
        return ++state.polls < 3 ? send(400, { error: "authorization_pending" }) : send(200, { access_token: KEY, token_type: "Bearer", scope: "apinoa", expires_in: 7_776_000, apinoa_credit_usd: "0.10" });
      }
      send(404, { error: "not_found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, state, close: () => new Promise((r) => server.close(r)) };
}

test("end to end: `apinoa-mcp login --out` against a local server writes the key and exits 0", async () => {
  const api = await deviceServer();
  try {
    const cwd = await tmp();
    const file = join(cwd, ".env");
    await writeFile(file, "FOO=1\n");
    const r = await cli(["login", "--out", file], { cwd, env: cleanEnv({ APINOA_API_URL: api.base }) });
    assert.equal(r.code, 0, r.err);
    assert.equal(await readFile(file, "utf8"), `FOO=1\nAPINOA_API_KEY=${KEY}\n`);
    assert.match(r.out, /WXYZ-BCDF/);
    assert.ok(r.out.includes(SHOWN));
    assert.match(r.out, /Your account received \$0\.10 of evaluation credit\./);
    assert.ok(!(r.out + r.err).includes(KEY));
    assert.equal(api.state.polls, 3);
    assert.deepEqual(api.seen[0], { path: "/oauth/device_authorization", type: "application/x-www-form-urlencoded", body: "client_id=apinoa-cli&scope=apinoa" });
    const poll = new URLSearchParams(api.seen[1].body);
    assert.equal(poll.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(poll.get("device_code"), "dc_e2e");
  } finally {
    await api.close();
  }
});

test("end to end: plain `apinoa-mcp login` creates .env in the working folder with mode 0600", async () => {
  const api = await deviceServer();
  try {
    const cwd = await tmp();
    const r = await cli(["login"], { cwd, env: cleanEnv({ APINOA_API_URL: api.base }) });
    assert.equal(r.code, 0, r.err);
    const file = join(cwd, ".env");
    assert.equal(await readFile(file, "utf8"), `APINOA_API_KEY=${KEY}\n`);
    if (POSIX) assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!(r.out + r.err).includes(KEY));
  } finally {
    await api.close();
  }
});

// Not --env-file: Node (20.6+) reads that flag past the script name and exits 9 before cli.js runs when the
// file does not exist yet. --out reaches the CLI, so a file that does not exist yet is created.
test("end to end: `--out` naming a file that does not exist yet creates it", async () => {
  const api = await deviceServer();
  try {
    const cwd = await tmp();
    const file = join(cwd, "new.env");
    const r = await cli(["login", "--out", file], { cwd, env: cleanEnv({ APINOA_API_URL: api.base }) });
    assert.equal(r.code, 0, r.err);
    assert.equal(await readFile(file, "utf8"), `APINOA_API_KEY=${KEY}\n`);
  } finally {
    await api.close();
  }
});

test("without `login`, the CLI is still the stdio MCP server, with the key warning, when the catalog cannot be reached", async () => {
  // A port nothing listens on: the live catalog fails at once and the bundled snapshot is used.
  const dead = createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));

  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
  const answer = (out) => out.split("\n").some((l) => l.includes('"id":1'));
  const r = await cli([], {
    cwd: await tmp(),
    env: cleanEnv({ APINOA_BASE_URL: `http://127.0.0.1:${port}`, APINOA_MCP_DATA_DIR: await tmp() }),
    input: JSON.stringify(initialize) + "\n",
    until: (out, err) => answer(out) && err.includes("APINOA_API_KEY is not set"),
    ms: 60_000,
  });
  const line = r.out.split("\n").find((l) => l.includes('"id":1'));
  assert.ok(line, `no answer to initialize\nstderr: ${r.err}`);
  const msg = JSON.parse(line);
  assert.equal(msg.result.serverInfo.name, "apinoa");
  assert.ok(msg.result.capabilities.tools);
  assert.match(r.err, /apinoa-mcp: APINOA_API_KEY is not set — list_platforms works, every data call will answer 401\./);
});

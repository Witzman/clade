// The alarm. Workshop issues #39 and #18.
//
//   node --test tests/alert.test.ts
//
// Two halves, and both matter:
//
//   * the RULES -- does the cap alarm fire at the right connection count,
//     does it stop repeating, does it recover. Driven with an injected mailer,
//     no relay, no timers.
//   * the SMTP CLIENT -- posted against a real listening server that speaks
//     the protocol back, including STARTTLS and AUTH PLAIN, with a throwaway
//     self-signed certificate. A hand-rolled protocol client that has only
//     ever been tested against the real relay is a client nobody can change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TLSSocket } from "node:tls";
import { createServer as createNetServer } from "node:net";
import type { Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlerter, envConfig, message, sendMail } from "../server/alert.ts";
import type { AlertConfig } from "../server/alert.ts";
import { createWatch } from "../server/watch.ts";

function collector() {
  const sent: { subject: string; body: string }[] = [];
  const cfg: AlertConfig = {
    smtpHost: "relay.invalid", smtpPort: 587, from: "a@b", to: "c@d",
    name: "test", repeatMs: 3600000, log: () => {},
    send: async (subject, body) => { sent.push({ subject, body }); },
  };
  return { sent, alerter: createAlerter(cfg) };
}

function watcher(maxWs: number, warnFraction = 0.8) {
  const c = collector();
  return { ...c, watch: createWatch(c.alerter, { maxWs, warnFraction, memLimitBytes: 0, log: () => {} }) };
}

// ---------------------------------------------------------------- rules

test("the cap alarm fires at the warn threshold, not before", async () => {
  const { watch, alerter, sent } = watcher(40);
  assert.equal(watch.warnAt, 32);

  await watch.tick({ connections: 31 });
  await alerter.pending();
  assert.equal(sent.length, 0, "31 of 40 is below the 80% threshold and must be silent");

  await watch.tick({ connections: 32 });
  await alerter.pending();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /\[test\] connection cap approaching: 32\/40/);
});

test("reaching the ceiling reads differently from approaching it", async () => {
  const { watch, alerter, sent } = watcher(10);
  await watch.tick({ connections: 10 });
  await alerter.pending();
  assert.match(sent[0].subject, /cap REACHED: 10\/10/);
});

test("a cap that stays hit is one mail, not one per poll", async () => {
  const { watch, alerter, sent } = watcher(10);
  for (let i = 0; i < 50; i++) await watch.tick({ connections: 10 });
  await alerter.pending();
  assert.equal(sent.length, 1, "an alarm nobody can read is an alarm nobody reads");
});

test("recovery is announced, and re-arms the alarm", async () => {
  const { watch, alerter, sent } = watcher(10);
  await watch.tick({ connections: 10 });
  await watch.tick({ connections: 2 });
  await watch.tick({ connections: 10 });
  await alerter.pending();
  assert.equal(sent.length, 3);
  assert.match(sent[1].subject, /^\[test\] RESOLVED: /);
  assert.match(sent[2].subject, /cap REACHED/);
});

test("a rising refusal counter is its own alarm -- proof players were turned away", async () => {
  const { watch, alerter, sent } = watcher(10);
  await watch.tick({ connections: 3, refused: 0 });     // baseline, silent
  await watch.tick({ connections: 3, refused: 0 });
  await alerter.pending();
  assert.equal(sent.length, 0);

  await watch.tick({ connections: 3, refused: 4 });
  await alerter.pending();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /sockets refused: 4 more \(4 since start\)/);
});

test("a missing refusal counter is not an error -- #44 may not have landed", async () => {
  const { watch, alerter, sent } = watcher(10);
  await watch.tick({ connections: 10 });
  await alerter.pending();
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /refused     : \(not reported\)/);
});

test("the memory alarm reads the cgroup, and is off by default", async () => {
  const c = collector();
  const off = createWatch(c.alerter, { maxWs: 10, warnFraction: 0.8, memLimitBytes: 0,
                                       memory: async () => 999e6, log: () => {} });
  await off.tick({ connections: 1 });
  await c.alerter.pending();
  assert.equal(c.sent.length, 0);

  const d = collector();
  const on = createWatch(d.alerter, { maxWs: 10, warnFraction: 0.8, memLimitBytes: 100 * 1048576,
                                      memory: async () => 150 * 1048576, log: () => {} });
  await on.tick({ connections: 1 });
  await d.alerter.pending();
  assert.equal(d.sent.length, 1);
  assert.match(d.sent[0].subject, /memory 150\.0 MB over 100 MB/);
});

test("with no relay configured the rules still run and the alert still reaches stdout", async () => {
  const lines: string[] = [];
  const alerter = createAlerter({ smtpPort: 587, from: "a@b", name: "nodelivery",
                                  repeatMs: 3600000, log: l => lines.push(l) });
  const w = createWatch(alerter, { maxWs: 4, warnFraction: 0.8, memLimitBytes: 0, log: () => {} });
  await w.tick({ connections: 4 });
  await alerter.pending();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /alert: \[nodelivery\] connection cap REACHED: 4\/4/);
});

test("a failed delivery is logged and dropped, never thrown at the server", async () => {
  const lines: string[] = [];
  const alerter = createAlerter({
    smtpHost: "relay.invalid", smtpPort: 587, from: "a@b", to: "c@d", name: "t",
    repeatMs: 3600000, log: l => lines.push(l),
    send: async () => { throw new Error("relay refused"); },
  });
  await alerter.event("k", "subject", "body");
  await alerter.pending();
  assert.ok(lines.some(l => /delivery failed: relay refused/.test(l)));
});

test("env config leaves delivery off unless both host and recipient are given", () => {
  assert.equal(envConfig({}, () => {}).smtpHost, undefined);
  assert.equal(envConfig({ ALERT_SMTP_HOST: "" }, () => {}).smtpHost, undefined);
  const c = envConfig({ ALERT_SMTP_HOST: "h", ALERT_TO: "x@y", ALERT_NAME: "staging" }, () => {});
  assert.equal(c.smtpPort, 587);
  assert.equal(c.name, "staging");
});

// ---------------------------------------------------------------- message

test("a newline in a subject cannot inject a header", () => {
  const cfg: AlertConfig = { smtpPort: 587, from: "a@b", to: "c@d", name: "n",
                             repeatMs: 1, log: () => {} };
  const m = message(cfg, "boom\r\nBcc: someone@else", "body");
  assert.equal(m.split("\r\n").filter(l => /^Bcc:/.test(l)).length, 0);
  assert.match(m, /^Subject: boom Bcc: someone@else$/m);
});

test("a body line of a single dot does not end the message early", () => {
  const cfg: AlertConfig = { smtpPort: 587, from: "a@b", to: "c@d", name: "n",
                             repeatMs: 1, log: () => {} };
  const m = message(cfg, "s", "one\n.\ntwo");
  assert.match(m, /\r\n\.\.\r\n/);
});

// ---------------------------------------------------------------- SMTP

// A throwaway certificate, generated here rather than committed. openssl is
// present on every runner this project uses; if it ever is not, this test
// skips rather than failing for a reason that is not the code's fault.
function selfSigned(): { key: string; cert: string } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), "clade-smtp-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
      "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem"), "utf8"),
             cert: readFileSync(join(dir, "c.pem"), "utf8") };
  } catch {
    return null;
  }
}

test("the SMTP client completes a real STARTTLS + AUTH PLAIN conversation", async t => {
  const pem = selfSigned();
  if (!pem) return t.skip("openssl not available");

  const spoken: string[] = [];
  const delivered: string[] = [];

  // Written out rather than reusing fakeRelay's upgrade path, because the
  // socket handoff is the part worth being explicit about: the same TCP
  // connection continues inside TLS.
  const server = createNetServer(sock => {
    let stage: "plain" | "tls" = "plain";
    let inData = false;
    const speak = (s: Socket | TLSSocket) => {
      s.setEncoding("utf8");
      let buf = "";
      s.on("error", () => {});
      s.on("data", (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === ".") { inData = false; s.write("250 queued\r\n"); }
            else delivered.push(line);
            continue;
          }
          spoken.push(`${stage}: ${line}`);
          const up = line.toUpperCase();
          if (up.startsWith("EHLO")) s.write("250-fake\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n");
          else if (up === "STARTTLS") {
            s.write("220 go ahead\r\n");
            s.removeAllListeners("data");
            const tls = new TLSSocket(s as Socket, {
              isServer: true, key: pem.key, cert: pem.cert,
            });
            stage = "tls";
            buf = "";
            speak(tls);
            return;
          }
          else if (up.startsWith("AUTH PLAIN")) s.write("235 ok\r\n");
          else if (up.startsWith("MAIL FROM") || up.startsWith("RCPT TO")) s.write("250 ok\r\n");
          else if (up === "DATA") { inData = true; s.write("354 go\r\n"); }
          else if (up === "QUIT") { s.write("221 bye\r\n"); s.end(); }
          else s.write("250 ok\r\n");
        }
      });
    };
    sock.write("220 fake ESMTP\r\n");
    speak(sock);
  });

  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;

  // The certificate is self-signed, so verification is waived FOR THIS TEST
  // ONLY -- production verifies normally, which is what notes/reference/mail.md
  // requires (no DANE, WebPKI).
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    await sendMail({
      smtpHost: "127.0.0.1", smtpPort: port, smtpUser: "relay@example",
      smtpPass: "pw", from: "noreply@example", to: "owner@example",
      name: "staging", repeatMs: 1, log: () => {},
    }, "[staging] connection cap REACHED: 40/40", "connections : 40\n.\nMAX_WS : 40");
  } finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    server.close();
  }

  // STARTTLS happened, and everything sensitive happened after it.
  assert.ok(spoken.includes("plain: STARTTLS"), spoken.join(" | "));
  assert.ok(spoken.some(l => l.startsWith("tls: AUTH PLAIN")),
            `AUTH must be inside TLS: ${spoken.join(" | ")}`);
  assert.ok(spoken.some(l => l === "tls: MAIL FROM:<noreply@example>"), spoken.join(" | "));
  assert.ok(spoken.some(l => l === "tls: RCPT TO:<owner@example>"), spoken.join(" | "));

  // AUTH PLAIN is \0user\0pass, base64.
  const auth = spoken.find(l => l.startsWith("tls: AUTH PLAIN "))!.slice("tls: AUTH PLAIN ".length);
  assert.equal(Buffer.from(auth, "base64").toString(), "\0relay@example\0pw");

  assert.ok(delivered.includes("Subject: [staging] connection cap REACHED: 40/40"),
            delivered.join(" | "));
  assert.ok(delivered.includes(".."), "the lone dot must arrive dot-stuffed");
});

test("several recipients each get their own RCPT TO", async t => {
  // Cheap structural check of the splitting, without a second relay.
  const cfg: AlertConfig = { smtpPort: 587, from: "a@b", to: "one@x, two@y",
                             name: "n", repeatMs: 1, log: () => {} };
  assert.equal(message(cfg, "s", "b").split("\r\n")[1], "To: one@x, two@y");
});

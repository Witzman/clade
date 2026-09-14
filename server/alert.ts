// The alarm. Workshop issues #39 (no working detection channel) and #18 (a
// connection cap nothing warns about).
//
// WHY THE SERVER ALERTS ON ITSELF. The only alerting channel this project had
// was a scheduled GitHub workflow, and it was measured running 3 times in
// 11.6 h against a claimed every-15-minutes (#39). GitHub's scheduler is best
// effort under load; asking for a shorter cron does not make it run more
// often. So detection had to come from somewhere else.
//
// It does not all have to come from the same somewhere. Split the failures:
//
//   process crashed / OOM-killed / crash-looping  -> the RESTARTED process
//                                                    can say so
//   cap saturated, players being turned away      -> this process can say so
//   certificate expiring                          -> the GitHub workflow,
//                                                    which is fine at days
//   HOST DOWN OR UNREACHABLE                      -> only a third party can
//                                                    see this. Still hours.
//
// Everything except the last line is visible from inside this process, in
// seconds, with no external service and no account. That is what this file
// is. The last line is a recommendation on #39, not code.
//
// WHY SMTP AND NOT A WEBHOOK. This project already owns a host-independent
// outbound mail path -- MXroute on 587, AUTH PLAIN, From: noreply@ aliased to
// a real mailbox (notes/reference/mail.md). It needs no signup and no payment,
// the owner already reads mail (that is how the GitHub alert reached him), and
// it deliberately does NOT go through this host's Postfix, so it survives the
// VPS migration untouched. Every value below arrives by environment variable:
// nothing here knows which host it is running on.
//
// WHY IT IS HAND-ROLLED. `ws` is the only runtime dependency of this server.
// A mail library would be the second, for ~100 lines of a protocol that
// notes/reference/mail.md has already measured end to end. One caveat from
// that page is honoured here: verify the certificate normally and do NOT
// attempt DANE -- MXroute publishes no TLSA records.
//
// WHY UNSET MEANS DISABLED. CI holds no credential and must stay green, and a
// developer running this locally must not mail anyone. With no ALERT_SMTP_HOST
// the alerter still evaluates every rule and still writes every alert to
// stdout -- so the logic is exercised everywhere, and only delivery is gated.

import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";

export type Mailer = (subject: string, body: string) => Promise<void>;

export type AlertConfig = {
  smtpHost?: string;
  smtpPort: number;
  smtpUser?: string;
  smtpPass?: string;
  from: string;
  to?: string;
  name: string;          // which deployment this is: "staging", "production"
  repeatMs: number;      // the same alert key is not re-sent inside this
  log: (line: string) => void;
  send?: Mailer;         // injected by the tests; real SMTP when absent
};

export type Alerter = {
  // Fires when `on` is true and this key was not already firing. Fires the
  // recovery when it goes false again. Returns whether anything was sent.
  state(key: string, on: boolean, subject: string, body: string): Promise<boolean>;
  // Fires unconditionally, subject to the repeat window.
  event(key: string, subject: string, body: string): Promise<boolean>;
  pending(): Promise<void>;
  firing(key: string): boolean;
};

export function envConfig(env: NodeJS.ProcessEnv, log: (l: string) => void): AlertConfig {
  return {
    smtpHost: env.ALERT_SMTP_HOST || undefined,
    smtpPort: Number(env.ALERT_SMTP_PORT || 587),
    smtpUser: env.ALERT_SMTP_USER || undefined,
    smtpPass: env.ALERT_SMTP_PASS || undefined,
    from: env.ALERT_FROM || "noreply@localhost",
    to: env.ALERT_TO || undefined,
    name: env.ALERT_NAME || "clade",
    repeatMs: Number(env.ALERT_REPEAT_MS || 3600000),
    log,
  };
}

export function createAlerter(cfg: AlertConfig): Alerter {
  const on = new Set<string>();
  const lastSent = new Map<string, number>();
  // Alerts are serialised. Two SMTP conversations at once against the same
  // relay is how a burst turns into a rate-limit block, and the burst is
  // exactly when the alerts matter.
  let queue: Promise<void> = Promise.resolve();

  const deliver = cfg.send ?? ((subject, body) => sendMail(cfg, subject, body));

  function enqueue(subject: string, body: string) {
    const line = `[${cfg.name}] ${subject}`;
    cfg.log(`alert: ${line}`);
    if (!cfg.smtpHost || !cfg.to) {
      // Not configured. The rule still ran and the alert is still on stdout,
      // which is where a container's logs are -- it is simply not mailed.
      return Promise.resolve(true);
    }
    queue = queue.then(() => deliver(line, body)).catch(e => {
      // A failed alert must never take the server down with it. It is logged
      // and dropped; the next occurrence tries again.
      cfg.log(`alert: delivery failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    return queue.then(() => true);
  }

  function throttled(key: string, now: number) {
    const last = lastSent.get(key);
    return last !== undefined && now - last < cfg.repeatMs;
  }

  return {
    async state(key, active, subject, body) {
      const now = Date.now();
      if (active) {
        if (on.has(key)) {
          // Still firing. Re-send only once per repeat window, so a cap that
          // stays saturated for an hour is one mail, not 240.
          if (throttled(key, now)) return false;
        }
        on.add(key);
        lastSent.set(key, now);
        await enqueue(subject, body);
        return true;
      }
      if (!on.has(key)) return false;
      on.delete(key);
      lastSent.delete(key);
      await enqueue(`RESOLVED: ${subject}`, body);
      return true;
    },
    async event(key, subject, body) {
      const now = Date.now();
      if (throttled(key, now)) return false;
      lastSent.set(key, now);
      await enqueue(subject, body);
      return true;
    },
    pending: () => queue,
    firing: key => on.has(key),
  };
}

// ---------------------------------------------------------------- SMTP
//
// Enough of RFC 5321 to post one message: EHLO, STARTTLS, AUTH PLAIN, MAIL
// FROM, RCPT TO, DATA, QUIT. Multi-line replies (250-...) are handled, because
// EHLO always sends one.

const CRLF = "\r\n";

export function sendMail(cfg: AlertConfig, subject: string, body: string): Promise<void> {
  const host = cfg.smtpHost;
  const to = cfg.to;
  if (!host || !to) return Promise.resolve();

  return new Promise<void>((done, fail) => {
    let sock: Socket | TLSSocket = netConnect({ host, port: cfg.smtpPort });
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => stop(new Error("smtp timeout")), 20000);

    function stop(err?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already gone */ }
      err ? fail(err) : done();
    }

    // Waits for a complete reply and checks its code. `expect` is the leading
    // digit(s); anything else is an error carrying the server's own words,
    // which is the only useful diagnostic a relay gives you.
    let waiting: ((line: string) => void) | null = null;
    function read(expect: string): Promise<string> {
      return new Promise((ok, no) => {
        waiting = line => {
          waiting = null;
          if (line.startsWith(expect)) ok(line);
          else no(new Error(`smtp: expected ${expect}, got ${line.slice(0, 120)}`));
        };
        pump();
      });
    }
    function pump() {
      if (!waiting) return;
      // A reply is complete when a line reads "NNN " (space, not hyphen).
      const m = buf.match(/^(?:\d{3}-[^\r\n]*\r?\n)*\d{3} [^\r\n]*\r?\n/);
      if (!m) return;
      const reply = m[0];
      buf = buf.slice(reply.length);
      waiting(reply.trim());
    }

    const attach = (s: Socket | TLSSocket) => {
      s.setEncoding("utf8");
      s.on("data", (d: string) => { buf += d; pump(); });
      s.on("error", e => stop(e instanceof Error ? e : new Error(String(e))));
      s.on("close", () => { if (!settled) stop(new Error("smtp: connection closed")); });
    };
    const write = (s: string) => sock.write(s + CRLF);

    attach(sock);

    (async () => {
      await read("220");
      write("EHLO clade");
      await read("250");
      write("STARTTLS");
      await read("220");

      // Upgrade. Certificate verified against the WebPKI in the normal way --
      // see notes/reference/mail.md: no DANE, MXroute publishes no TLSA.
      const plain = sock;
      plain.removeAllListeners("data");
      plain.removeAllListeners("error");
      plain.removeAllListeners("close");
      buf = "";
      const secure = tlsConnect({ socket: plain, servername: host });
      sock = secure;
      attach(secure);
      await new Promise<void>((ok, no) => {
        secure.once("secureConnect", () => ok());
        secure.once("error", e => no(e));
      });

      write("EHLO clade");
      await read("250");

      if (cfg.smtpUser && cfg.smtpPass) {
        const plainAuth = Buffer.from(`\0${cfg.smtpUser}\0${cfg.smtpPass}`).toString("base64");
        write(`AUTH PLAIN ${plainAuth}`);
        await read("235");
      }

      write(`MAIL FROM:<${cfg.from}>`);
      await read("250");
      for (const rcpt of to.split(",").map(a => a.trim()).filter(Boolean)) {
        write(`RCPT TO:<${rcpt}>`);
        await read("250");
      }
      write("DATA");
      await read("354");
      write(message(cfg, subject, body));
      write(".");
      await read("250");
      write("QUIT");
      stop();
    })().catch(e => stop(e instanceof Error ? e : new Error(String(e))));
  });
}

// RFC 5322. Dot-stuffing matters: a body line that is a single "." would
// otherwise end the message early.
export function message(cfg: AlertConfig, subject: string, body: string): string {
  const date = new Date().toUTCString();
  const id = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@clade`;
  const text = body.split(/\r?\n/).map(l => (l.startsWith(".") ? "." + l : l)).join(CRLF);
  return [
    `From: ${cfg.from}`,
    `To: ${cfg.to}`,
    `Subject: ${headerSafe(subject)}`,
    `Date: ${date}`,
    `Message-ID: <${id}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Auto-Submitted: auto-generated",
    "",
    text,
  ].join(CRLF);
}

// A subject is assembled from runtime values. A newline in one of them would
// inject headers, so they never reach the wire.
function headerSafe(s: string) {
  const clean = s.replace(/[\r\n]+/g, " ").slice(0, 200);
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

// Email reminders over SMTP (works with a Gmail "App password", or any SMTP provider).
//
//   SMTP_USER   the account that sends the mail, e.g. you@gmail.com
//   SMTP_PASS   its password — for Gmail an App password (Google Account → Security → App passwords)
//   SMTP_HOST   default smtp.gmail.com        SMTP_PORT   default 465 (SSL)
//   MAIL_FROM   optional "Name <address>"; defaults to "مهامي <SMTP_USER>"
//
// Returns null when not configured, so email is simply turned off.
import nodemailer from 'nodemailer';

export function createMailer(env = process.env) {
  if (!env.SMTP_USER || !env.SMTP_PASS) return null;
  const port = Number(env.SMTP_PORT) || 465;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS.replace(/\s+/g, '') },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const from = env.MAIL_FROM || `مهامي <${env.SMTP_USER}>`;
  return { send: (msg) => transport.sendMail({ from, ...msg }) };
}

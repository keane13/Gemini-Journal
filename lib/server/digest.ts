/**
 * @file lib/server/digest.ts
 * FEATURE 8: Weekly digest -- payload construction and email rendering.
 *
 * PAYLOAD MINIMIZATION IS THE POINT OF THIS MODULE.
 * The digest is built exclusively from counters maintained at write time in
 * /digestCounters/{uid}. It never reads entries, messages, chunks, insights, or
 * commitment text -- not even with a service credential. Consequently there is no code
 * path here that could leak entry text, titles, or model output, because none of that
 * data is ever loaded.
 *
 * Mood is reported QUALITATIVELY as a direction word. No numeric score is emitted, and
 * the digest is never triggered by mood: see /api/cron/digest, which selects recipients
 * purely by enrollment and schedule.
 *
 * The renderer below is the single source of truth for the email body. The settings
 * preview and the scheduled send both call it, so what a user previews is byte-for-byte
 * what gets sent.
 */

export interface DigestCounters {
  /** isoWeek -> per-week write-time counters. */
  weeks?: Record<
    string,
    {
      entries?: number;
      moodSum?: number;
      moodCount?: number;
      themesCount?: number;
    }
  >;
  /**
   * Due timestamps (epoch ms) for currently-open commitments. Timestamps only --
   * commitment text is never copied here.
   */
  openCommitmentDueAt?: number[];
}

export type MoodDirection = 'steadier' | 'lighter' | 'heavier' | 'mixed' | 'not enough signal';

export interface DigestPayload {
  isoWeek: string;
  previousIsoWeek: string;
  entriesWritten: number;
  moodDirection: MoodDirection;
  recurringThemeCount: number;
  overdueCommitmentCount: number;
  openCommitmentCount: number;
  generatedAt: string;
}

/**
 * ISO-8601 week identifier, e.g. "2026-W36". Weeks start Monday; the week containing
 * the year's first Thursday is week 1.
 */
export function isoWeekOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Shift to the Thursday of the current week.
  const dayNumber = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The ISO week seven days before the given date. */
export function previousIsoWeek(date: Date): string {
  return isoWeekOf(new Date(date.getTime() - 7 * 86400000));
}

/**
 * Converts two weeks of mood averages into a direction word.
 * Deliberately coarse: the digest states a direction, never a score.
 */
export function describeMoodDirection(
  current: { sum: number; count: number },
  previous: { sum: number; count: number }
): MoodDirection {
  if (current.count < 2) return 'not enough signal';

  const currentAvg = current.sum / current.count;
  if (previous.count < 2) {
    // No comparison basis; describe the week on its own terms.
    if (currentAvg > 0.15) return 'lighter';
    if (currentAvg < -0.15) return 'heavier';
    return 'steadier';
  }

  const previousAvg = previous.sum / previous.count;
  const delta = currentAvg - previousAvg;

  if (Math.abs(delta) < 0.1) return 'steadier';
  if (delta >= 0.1 && delta < 0.35) return 'lighter';
  if (delta >= 0.35) return 'lighter';
  if (delta <= -0.35) return 'heavier';
  if (delta <= -0.1) return 'heavier';
  return 'mixed';
}

/** Builds the digest payload from write-time counters. Loads no journal content. */
export function buildDigestPayload(
  counters: DigestCounters,
  now: Date = new Date()
): DigestPayload {
  const isoWeek = isoWeekOf(now);
  const prevWeek = previousIsoWeek(now);

  const current = counters.weeks?.[isoWeek] ?? {};
  const previous = counters.weeks?.[prevWeek] ?? {};

  const dueTimestamps = counters.openCommitmentDueAt ?? [];
  const nowMs = now.getTime();

  return {
    isoWeek,
    previousIsoWeek: prevWeek,
    entriesWritten: current.entries ?? 0,
    moodDirection: describeMoodDirection(
      { sum: current.moodSum ?? 0, count: current.moodCount ?? 0 },
      { sum: previous.moodSum ?? 0, count: previous.moodCount ?? 0 }
    ),
    recurringThemeCount: current.themesCount ?? 0,
    overdueCommitmentCount: dueTimestamps.filter((t) => typeof t === 'number' && t < nowMs).length,
    openCommitmentCount: dueTimestamps.length,
    generatedAt: now.toISOString(),
  };
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MOOD_SENTENCE: Record<MoodDirection, string> = {
  steadier: 'Your entries read about as steady as last week.',
  lighter: 'Your entries read a little lighter than last week.',
  heavier: 'Your entries read a little heavier than last week.',
  mixed: 'Your entries read mixed compared with last week.',
  'not enough signal': 'Not enough entries this week to say anything about direction.',
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Renders the exact email that will be sent.
 *
 * Everything here is derived from counts and one direction word. There is deliberately
 * no parameter through which entry text, titles, or model output could enter.
 */
export function renderDigestEmail(payload: DigestPayload, appUrl: string): RenderedEmail {
  const base = appUrl.replace(/\/+$/, '');
  const links = {
    journal: `${base}/`,
    commitments: `${base}/?view=commitments`,
    year: `${base}/?view=year`,
    settings: `${base}/?view=settings`,
  };

  const subject = `Your week in review — ${payload.isoWeek}`;

  const lines = [
    `Your week in review (${payload.isoWeek})`,
    '',
    `You wrote ${plural(payload.entriesWritten, 'entry', 'entries')} this week.`,
    MOOD_SENTENCE[payload.moodDirection],
    `${plural(payload.recurringThemeCount, 'recurring theme', 'recurring themes')} surfaced.`,
    payload.overdueCommitmentCount > 0
      ? `${plural(payload.overdueCommitmentCount, 'commitment is', 'commitments are')} past the time you named.`
      : 'No commitments are past the time you named.',
    '',
    'Open your journal:      ' + links.journal,
    'Review commitments:     ' + links.commitments,
    'See the year view:      ' + links.year,
    '',
    '---',
    'This email contains counts only. It never includes your entry text, entry titles,',
    'or anything Gemini wrote. It was sent from your own Google account to yourself, so',
    'no third-party email service received it.',
    '',
    `Turn this off any time: ${links.settings}`,
  ];

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#141821;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#E9E5DD;">
  <div style="max-width:520px;margin:0 auto;background:#1C212B;border:1px solid #2A303C;border-radius:8px;padding:24px;">
    <h1 style="margin:0 0 4px;font-size:16px;font-weight:600;">Your week in review</h1>
    <p style="margin:0 0 20px;font-size:12px;color:#8D96A5;">${escapeHtml(payload.isoWeek)}</p>

    <ul style="list-style:none;padding:0;margin:0 0 20px;font-size:14px;line-height:1.7;">
      <li>You wrote <strong>${payload.entriesWritten}</strong> ${
        payload.entriesWritten === 1 ? 'entry' : 'entries'
      } this week.</li>
      <li>${escapeHtml(MOOD_SENTENCE[payload.moodDirection])}</li>
      <li><strong>${payload.recurringThemeCount}</strong> recurring ${
        payload.recurringThemeCount === 1 ? 'theme' : 'themes'
      } surfaced.</li>
      <li>${
        payload.overdueCommitmentCount > 0
          ? `<strong>${payload.overdueCommitmentCount}</strong> ${
              payload.overdueCommitmentCount === 1 ? 'commitment is' : 'commitments are'
            } past the time you named.`
          : 'No commitments are past the time you named.'
      }</li>
    </ul>

    <p style="margin:0 0 20px;font-size:13px;">
      <a href="${links.journal}" style="color:#0EA5E9;">Open your journal</a> &nbsp;·&nbsp;
      <a href="${links.commitments}" style="color:#0EA5E9;">Review commitments</a> &nbsp;·&nbsp;
      <a href="${links.year}" style="color:#0EA5E9;">Year view</a>
    </p>

    <hr style="border:none;border-top:1px solid #2A303C;margin:20px 0;">
    <p style="margin:0 0 8px;font-size:11px;color:#8D96A5;line-height:1.6;">
      This email contains counts only. It never includes your entry text, entry titles, or
      anything Gemini wrote. It was sent from your own Google account to yourself, so no
      third-party email service received it.
    </p>
    <p style="margin:0;font-size:11px;color:#8D96A5;">
      <a href="${links.settings}" style="color:#8D96A5;">Turn this off any time</a>
    </p>
  </div>
</body>
</html>`;

  return { subject, text: lines.join('\n'), html };
}

/**
 * Builds an RFC 2822 message, base64url-encoded for the Gmail send API.
 * `to` and `from` are the same address: the user's own mailbox.
 */
export function buildRawGmailMessage(
  address: string,
  email: RenderedEmail
): string {
  const boundary = `b_${Math.random().toString(36).slice(2)}`;
  const message = [
    `From: ${address}`,
    `To: ${address}`,
    `Subject: ${email.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    email.text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    email.html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return Buffer.from(message, 'utf8').toString('base64url');
}

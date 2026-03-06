/**
 * Notifications:
 *   1. GitHub Issue comment (always available in GH Actions, no secrets needed)
 *   2. SMTP email (optional, via SMTP_* env vars)
 */

const https    = require('https');
const nodemailer = require('nodemailer');

// ─── GitHub Issue Notification ───────────────────────────────────────────────

/**
 * Create or comment on the tracking GitHub Issue.
 * Uses the GITHUB_TOKEN automatically available in Actions.
 *
 * @param {string} markdown  - change summary in Markdown
 * @param {object} store     - store module (to read/write issue number)
 * @param {string} repo      - "owner/repo" e.g. "MarkSchmidts/trainex-sync"
 * @param {string} token     - GitHub token (process.env.GITHUB_TOKEN)
 */
async function notifyGitHub(markdown, store, repo, token) {
  if (!token) {
    console.log('[notify] No GITHUB_TOKEN, skipping GitHub notification');
    return;
  }

  const state = store.readState();
  let issueNumber = state.issueNumber;

  // If no tracking issue yet, create one
  if (!issueNumber) {
    console.log('[notify] Creating tracking issue...');
    issueNumber = await createIssue(repo, token,
      '📅 MSH TraiNex – Stundenplan-Tracking',
      [
        '## MSH TraiNex Stundenplan-Tracker',
        '',
        'Dieses Issue wird automatisch aktualisiert, wenn sich der Stundenplan in TraiNex ändert.',
        '**Beobachte dieses Issue**, um E-Mail-Benachrichtigungen bei Änderungen zu erhalten.',
        '',
        '_Erstellt von trainex-sync_',
      ].join('\n')
    );
    store.setIssueNumber(issueNumber);
    console.log(`[notify] Created tracking issue #${issueNumber}`);
  }

  // Add a comment with the change report
  await addComment(repo, token, issueNumber, markdown);
  console.log(`[notify] Added comment to issue #${issueNumber}`);
  return issueNumber;
}

async function ghApiRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data   = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization:  `token ${token}`,
        Accept:         'application/vnd.github.v3+json',
        'User-Agent':   'trainex-sync/1.0',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`GitHub API ${res.statusCode}: ${raw}`));
        } else {
          resolve(JSON.parse(raw));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function createIssue(repo, token, title, body) {
  const resp = await ghApiRequest('POST', `/repos/${repo}/issues`, token, {
    title,
    body,
    labels: ['trainex-sync'],
  });
  return resp.number;
}

async function addComment(repo, token, issueNumber, body) {
  await ghApiRequest('POST', `/repos/${repo}/issues/${issueNumber}/comments`, token, { body });
}

// ─── SMTP Email Notification ─────────────────────────────────────────────────

/**
 * Send email notification via SMTP (optional).
 * Requires env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL
 */
async function notifyEmail(markdown, subject) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[notify] SMTP not configured, skipping email');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   parseInt(SMTP_PORT || '587'),
    secure: parseInt(SMTP_PORT || '587') === 465,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  });

  // Convert markdown to simple HTML
  const html = markdownToHtml(markdown);

  await transporter.sendMail({
    from:    SMTP_USER,
    to:      NOTIFY_EMAIL || 'mark.schmidts@student.medicalschool-hamburg.de',
    subject: subject || '📅 MSH TraiNex – Stundenplan-Änderung',
    text:    markdown,
    html,
  });

  console.log(`[notify] Email sent to ${NOTIFY_EMAIL}`);
  return true;
}

/** Very simple markdown → HTML converter for email. */
function markdownToHtml(md) {
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:auto;padding:20px">${html}</body></html>`;
}

module.exports = { notifyGitHub, notifyEmail };

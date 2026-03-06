/**
 * POST /api/trigger
 * Dispatches the GitHub Actions daily-check workflow manually.
 * Requires GITHUB_TOKEN env var (set in Vercel project settings).
 */
const https = require('https');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY || 'MarkSchmidts/trainex-sync';

  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  try {
    await dispatchWorkflow(repo, token, 'daily-check.yml');
    res.json({ success: true, message: 'Workflow triggered. Check back in ~2 minutes.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

function dispatchWorkflow(repo, token, workflowFile) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ ref: 'main' });
    const opts = {
      hostname: 'api.github.com',
      path:     `/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
      method:   'POST',
      headers: {
        Authorization:  `token ${token}`,
        Accept:         'application/vnd.github.v3+json',
        'User-Agent':   'trainex-sync/1.0',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (r) => {
      if (r.statusCode === 204) return resolve();
      let raw = '';
      r.on('data', c => raw += c);
      r.on('end', () => reject(new Error(`GitHub API ${r.statusCode}: ${raw}`)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

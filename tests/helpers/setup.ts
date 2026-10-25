// Global test setup: deterministic env for config().
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-long-enough-123';
process.env.CRON_SECRET ??= 'test-cron-secret-1234567890';
process.env.ALLOWED_EMAIL_DOMAINS ??= 'cavendish.ac.ug';
process.env.APP_URL ??= 'http://localhost:3000';
delete process.env.RESEND_API_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;

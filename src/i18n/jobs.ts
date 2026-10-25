/**
 * Strings for scheduled jobs and transactional email (FR-NOT-1, design §12).
 * Kept apart from en.ts so parallel agents do not edit the same file.
 * Placeholders use `{name}` and go through `interpolate`.
 */
export const jobs = {
  email: {
    org: 'Dean of Students · Cavendish University Uganda',
    greeting: 'Hello {name},',
    greetingAnon: 'Hello,',
    buttonFallback: 'If the button does not work, copy this link into your browser:',
    footerContact: 'Questions? Email the Dean of Students at {email} or visit the office.',
    footerHours: 'Office hours: Monday to Friday, 8:30 to 17:00 (EAT).',
    footerAutomated: 'This is an automated message from {app}. Replies to this address are not read; use the Messages page instead.',
    receipt: {
      subject: 'Received: your Student Pass application {ref}',
      preheader: 'Your reference number is {ref}.',
      heading: 'We received your application',
      body: [
        'Your reference number is {ref}. Keep it for any questions about your Student Pass.',
        'The Dean of Students will check your documents. We will email you as soon as anything changes.',
      ],
      cta: 'View your application',
    },
    corrections: {
      subjectOne: 'Action needed: fix 1 document for {ref}',
      subjectMany: 'Action needed: fix {count} documents for {ref}',
      preheader: 'Only the documents listed need to be replaced.',
      heading: 'Please fix these documents',
      outro: 'Everything else is fine. You only need to replace the documents listed above.',
      cta: 'Fix now',
    },
    approved: {
      subject: 'Approved: your documents for {ref}',
      preheader: 'Your documents are approved.',
      heading: 'Your documents are approved',
      body: ["Your documents are approved and are being prepared for immigration. You'll get an email when they have been sent."],
      cta: 'View status',
    },
    sent: {
      subject: 'Sent to immigration: {ref}',
      preheader: 'Your documents are with the immigration office.',
      heading: 'Your documents were sent to immigration',
      body: ['The Dean of Students sent your documents to the immigration office. We will email you when your pass is ready.'],
      cta: 'View status',
    },
    passIssued: {
      subject: 'Your Student Pass is ready ({ref})',
      preheader: 'Your new pass expires on {date}.',
      heading: 'Your Student Pass is ready',
      body: ['Your new pass expires on {date}. We will remind you before it is time to renew.'],
      cta: 'View status',
    },
    message: {
      subject: 'New message about your application {ref}',
      subjectNoRef: 'New message from the Dean of Students',
      preheader: 'You have a new message.',
      heading: 'You have a new message',
      cta: 'Read and reply',
    },
    reminder: {
      subject: 'Action needed: your Student Pass expires on {date}. Apply by {applyBy}',
      subjectPastApplyBy: 'Urgent: your Student Pass expires on {date}. Apply today',
      subjectNoApplyBy: 'Reminder: your Student Pass expires on {date}',
      subjectToday: 'Urgent: your Student Pass expires today',
      subjectExpired: 'Your Student Pass has expired: contact the Dean of Students today',
      preheader: 'Your Student Pass expires on {date}.',
      heading: 'Your Student Pass expires on {date}',
      headingToday: 'Your Student Pass expires today',
      headingExpired: 'Your Student Pass has expired',
      runwayLine: 'Apply by {applyBy}.',
      runwayLinePast: 'The apply-by date ({applyBy}) has passed. Apply today.',
      runwayToday: 'Apply today.',
      runwayExpired: 'Expired on {date}. The illegal-stay penalty (about USD {rate} per day) applies every day until you renew.',
      bodyStart: 'You have not started a Student Pass application yet. It takes about 15 minutes with your phone camera.',
      bodyDraft: 'You have started an application but not submitted it yet. Finish it so the Dean of Students can review your documents.',
      bodyExpired: 'Contact the Dean of Students today so we can help you renew as quickly as possible.',
      ctaStart: 'Start your application',
      ctaDraft: 'Finish your application',
    },
    staffAlert: {
      subject: '{app}: {text}',
      heading: 'Staff alert',
      cta: 'Open dashboard',
    },
  },
  runway: {
    expiredDigest: '{count} student(s) without a submitted application have an expired Student Pass. See Runway flags on the dashboard.',
  },
} as const;

export type JobsMessages = typeof jobs;

/** Plain-language Scan Coach messages (design §1 principle 4: errors are instructions). Pure. */
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';
import type { QualityIssue, Side } from './quality';

const q = studentText.quality;

export function issueMessage(issue: QualityIssue): string {
  switch (issue.code) {
    case 'glare': {
      const side = issue.detail && issue.detail in q.sides ? q.sides[issue.detail as keyof typeof q.sides] : '';
      return interpolate(q.issues.glare, { side });
    }
    case 'cropped': {
      const sides = (issue.detail ?? '')
        .split(',')
        .filter(Boolean)
        .map((s) => q.cropSides[s as Side] ?? s)
        .join(', ');
      return interpolate(q.issues.cropped, { detail: sides });
    }
    default:
      return interpolate(q.issues[issue.code], { detail: issue.detail ?? '' });
  }
}

/** One sentence for the aria-live region. */
export function qualityAnnouncement(issues: QualityIssue[]): string {
  if (!issues.length) return q.ok;
  const hard = issues.filter((i) => i.severity === 'hard');
  if (hard.length) return `${interpolate(q.hardSummary, { count: hard.length })} ${hard.map(issueMessage).join(' ')}`;
  return `${interpolate(q.softSummary, { count: issues.length })} ${issues.map(issueMessage).join(' ')}`;
}

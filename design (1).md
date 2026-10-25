# VisaDesk — Design

Visual and interaction spec. Pair with `prd.md` (behaviour) and `architecture.md` (build).

## 1. Design direction

**"Calm authority with a clock in it."** This is a bureaucratic task with real consequences, usually done by an anxious student on a phone. The interface should feel like a trusted, unhurried official helper: clean, warm, unambiguous. Urgency is communicated by the **Runway**, not by alarm colours everywhere.

Principles:
1. **One job per screen** on mobile. Never show a student more than one decision at a time.
2. **Show, don't tell**: example thumbnails, live quality feedback, progress rings.
3. **Say what happens next** after every action.
4. **Errors are instructions**: "Too blurry. Hold steady, tap to focus, and retake." Never "Invalid file."
5. **Time is a first-class object**: dates, runway and risk are always visible.

## 2. Brand tokens (placeholders until Cavendish brand assets are provided)

Implement as CSS variables in `app/globals.css` and mirror in `tailwind.config`. Provide light and dark themes.

```css
:root {
  /* Brand */
  --brand-900: #0b2545;  /* deep ink navy */
  --brand-700: #13315c;
  --brand-500: #1f5fbf;  /* primary action */
  --brand-100: #e6eefb;
  --accent-500: #c8963e; /* academic gold, used sparingly */

  /* Neutrals (warm) */
  --ink: #14181f;  --ink-muted: #4b5563;  --line: #e3e0d8;
  --paper: #fbfaf7; --surface: #ffffff;

  /* Risk bands (also paired with icons + text, never colour alone) */
  --risk-safe: #1f8a5b;
  --risk-plan: #2f6fdb;
  --risk-urgent: #c77a00;
  --risk-critical: #c2410c;
  --risk-expired: #b42318;
  --risk-nopass: #6b7280;

  /* Status */
  --ok: #1f8a5b; --warn: #c77a00; --bad: #b42318; --info: #2f6fdb;

  --radius-sm: 8px; --radius-md: 14px; --radius-lg: 22px;
  --shadow-1: 0 1px 2px rgb(20 24 31 / .06), 0 4px 12px rgb(20 24 31 / .06);
}
[data-theme="dark"] {
  --ink: #eef1f6; --ink-muted: #a7b0bf; --line: #2a3140;
  --paper: #0e1219; --surface: #151b25; --brand-100: #14233f;
}
```

Contrast: all text/background pairs ≥ 4.5:1 (check risk colours on both themes).

## 3. Typography

- **UI/body:** `Inter` (variable), fallback system sans. 16 px base, 1.5 line-height; never below 14 px.
- **Headings:** `Fraunces` or `Source Serif 4` for H1/H2 only, to add an academic tone; 600 weight.
- **Numbers/IDs/dates:** `JetBrains Mono` or tabular-nums Inter for reference numbers (`VD-2026-00042`), countdowns, hashes.
- Scale: 12 / 14 / 16 / 18 / 22 / 28 / 36. Use fluid clamp for H1.
- Date format everywhere: `23 Oct 2026`. Relative text next to it: "in 38 days".

## 4. Layout and responsiveness

- **Mobile-first** (360 px baseline). Student UI is a single column with a sticky bottom action bar (thumb reach). Staff UI is desktop-first (≥ 1280 px) but usable on tablet.
- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48.
- Touch targets ≥ 48 px. Safe-area insets respected.
- Max content width: student 560 px; dashboard fluid with 1440 px cap.

## 5. Signature component: Visa Runway

A horizontal timeline (vertical on very narrow screens is *not* used; keep horizontal and scale).

```
 TODAY ───────────●────────── APPLY BY ────── EXPIRY ▓▓▓▓ penalty zone
                  you are here   12 Nov       12 Dec     (USD 20/day)
```

- Segments: **Runway** (today → apply-by, filled in the band colour), **Grace** (apply-by → expiry, hatched), **Penalty zone** (after expiry, red hatched, only when relevant).
- A marker pulses once on load (respect reduced motion).
- Headline text states the situation in words: "You have **15 days** to apply (by 12 Nov 2026)." / "Your pass expires in **8 days**. Apply today." / "Your pass expired **3 days ago**. Estimated penalty: **USD 60**. Contact the Dean of Students."
- Icons accompany colours (✓ safe, ◔ plan, ! urgent, ‼ critical, ⛔ expired).
- Compact variant (a 120 px bar with a dot) is used in the staff table; hover shows details.

## 6. Student experience

### 6.1 Flow
`Sign in → Welcome & profile (3 fields at a time) → Your checklist → Document capture (one per screen) → Review everything → Submit → Status`

### 6.2 Screens

1. **Sign in:** email field, "We'll email you a 6-digit code." Domain hint: "Use your @cavendish.ac.ug address." Resend countdown, large code input with auto-advance and paste support.
2. **Welcome/profile:** friendly questions in plain language ("What type of student are you?" as three large cards: New, Continuing, Masters). Nationality is a searchable select with flags. Pass expiry uses a native date picker with a "I don't have a pass yet" toggle.
3. **Checklist (home):** Runway at top; fee banner (waived/required); progress ring "5 of 8 done"; list of document cards with state chips: *To do*, *Checking…*, *Uploaded*, *Needs fixing*, *Approved*. Tapping a card opens capture. Sticky "Continue" jumps to the next undone item.
4. **Document capture (Scan Coach):**
   - Top: document name, one-line why, "Where to get it" link/text, example thumbnail (tap to enlarge).
   - Camera view with an on-screen **frame guide** shaped to the document (passport page landscape, ID card, A4 portrait). Live tips: "Move closer", "Reduce glare", "Hold steady".
   - After capture: preview with auto-detected crop handles, rotate button, quality report card (✓ Sharp, ✓ Size OK, ⚠ Glare on the right side). Buttons: **Use this scan** (primary), **Retake**.
   - Multi-page items (admission letter) show page slots: "Page 1 ✓ · Page 2 +".
   - Alternative entry: "Choose from gallery or files" with accepted types listed in plain words ("Photos or PDFs are fine. We convert them to JPG for you.").
5. **Review & submit:** grid of thumbnails with edit buttons, data summary, checkbox "I confirm these are my original documents", **Submit application**. If blocked, a list of what's missing with jump links.
6. **Status:** timeline of events (Submitted → Under review → …), reference number with copy button, what-happens-next paragraph, messages tab. In *Corrections needed*, the rejected documents appear first with the DOS reason in a highlighted card and a **Fix now** button.
7. **After approval:** clear instruction ("Your documents are approved and being sent to immigration. You'll get an email when your pass is ready.").

### 6.3 Micro-copy rules
- Reading age ~ grade 8; avoid jargon ("data page" gets a thumbnail). Short sentences, active voice.
- Never blame: "We couldn't read the passport number" not "You uploaded a bad image".
- Always state the next step and the date when relevant.

## 7. Staff experience

### 7.1 Dashboard
- Top: five summary tiles (Needs review, Corrections pending, Critical/Expired, Ready for immigration, Fees unpaid); click to filter.
- Table columns: Student (name, no.), Type, Nationality (flag), **Runway bar**, Status chip, Docs (e.g. 6/8 approved), Fee, Last activity. Row hover shows quick actions.
- Filter bar with saved views ("Urgent this week", "Awaiting my review").
- Bulk-action bar appears on selection.
- Keyboard: `/` search, `j/k` move, `Enter` open.

### 7.2 Application detail
Three-column on desktop: left student info + Runway + fee; centre document grid; right timeline and messages (with an internal-note toggle that visually differs: tinted background and lock icon).

### 7.3 Review Mode
- Full-screen, minimal chrome. Left (65%): document viewer with zoom, pan, rotate, brightness/contrast sliders, and a magnifier loupe (hold `Z`). Right (35%): checklist for this document type ("Name matches passport? Photo clear? Stamp visible?"), entered student data for comparison, decision buttons.
- **Approve** (green, `A`), **Reject** (red, `R`) opens reason chips (templates) + optional note; submit with `Enter`.
- Progress strip: "Document 4 of 23 in queue". `?` shows hotkeys. Undo toast for 8 seconds after a decision.
- Claim banner if someone else is viewing.

### 7.4 Packet screen
Preview of file list in the exact export order and naming, cover sheet preview, **Generate packet** and **Mark sent** (date, method) actions, and the stored manifest hashes.

### 7.5 Admin
Rule-set editor shows a **diff against the published version** before publishing and a plain-language summary of impact ("This adds 1 document for Masters students; 14 in-flight applications keep v3").

## 8. States and feedback

Every view defines: loading (skeletons, not spinners), empty (helpful illustration plus next step), error (what happened, what to do, retry), offline (banner "You're offline. Your progress is saved; uploads will resume"), success (brief toast plus clear state change).

Chips: *To do* grey, *Checking* blue with spinner, *Uploaded* teal, *Needs fixing* amber, *Approved* green, *Rejected* red. Always icon plus text.

## 9. Motion

- 150–220 ms ease-out for state changes; 400 ms for Runway marker entrance.
- Shutter/scan success micro-animation (a gentle frame snap) under 300 ms.
- Respect `prefers-reduced-motion`: replace with fades or none.

## 10. Accessibility

- WCAG 2.2 AA minimum; focus rings 2 px, 3:1 contrast; skip-to-content link.
- Camera and upload controls have text labels and `aria-live` announcements for quality results ("Image is sharp. Ready to upload.").
- Colour never the only signal (icons, text, patterns on the Runway).
- Forms: visible labels, inline errors tied with `aria-describedby`, error summary at the top on submit.
- Document viewer fully keyboard operable; alt text for thumbnails: "Passport data page, uploaded 23 Oct 2026, approved".
- Test with TalkBack and VoiceOver; zoom to 200% without loss.

## 11. Iconography and imagery

Lucide icons, 1.5 px stroke. Illustrations: simple line style in brand navy and gold; avoid stock photos of people. Example document thumbnails must be **fictional specimens** with "SPECIMEN" watermark (never real IDs).

## 12. Email design

Single-column, 560 px, plain-text alternative, one primary button. Subject lines are explicit: "Action needed: fix 1 document for VD-2026-00042". Include the Runway summary line ("Apply by 12 Nov 2026") in reminders. Footer: Dean of Students contact, office hours, and a line that this is an automated message.

## 13. Content: statuses (student-facing labels)

| Internal | Student sees | Explanation shown |
|---|---|---|
| draft | Getting ready | Finish your checklist, then submit. |
| submitted | Received | The Dean of Students will review soon. |
| under_review | Being checked | We're checking your documents. |
| corrections_needed | Needs your attention | Fix the highlighted documents. |
| approved | Approved | Your documents are complete. |
| sent_to_immigration | With immigration | We've sent your documents. |
| pass_issued | Pass ready | Your new pass expires on {date}. |
| closed | Done | Nothing more to do for now. |

## 14. Design deliverables for Claude Code

- Implement tokens, base components (Button, Chip, Card, Input, Select, Dialog, Toast, Tabs, Table, Stepper), then domain components (`Runway`, `RunwayCompact`, `ChecklistCard`, `ScanCoach`, `QualityReport`, `DocViewer`, `ReasonPicker`, `Timeline`, `PacketPreview`).
- Provide a `/dev/styleguide` route (disabled in production) rendering every component and state in both themes.
- Add Storybook or the styleguide route to Playwright visual snapshots at 360, 768, and 1280 px.

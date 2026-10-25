# VisaDesk — Concept

> Working name: **VisaDesk** (Cavendish University Uganda Student Pass portal). Rename freely; keep it in one config constant (`APP_NAME`).

## 1. The problem

International students at Cavendish University Uganda must hold a valid Student Pass. Today they scan up to 9 documents, email them as JPGs to `dos@cavendish.ac.ug`, and wait. This creates:

- **Incomplete submissions** (wrong format, missing page 2 of the admission letter, blurry passport scans).
- **Scattered evidence**: attachments buried in an inbox, no single status per student.
- **Silent expiry risk**: nobody is tracking who is about to overstay. Illegal stay costs **USD 20 per day** under Ugandan law, for every nationality.
- **Heavy DOS workload**: chasing, re-explaining requirements, and manually packaging files for immigration.
- **Sensitive data exposure**: passports and ID cards sitting in email.

## 2. The idea

VisaDesk is **a guided, mobile-first submission portal for students and a review desk for the Dean of Students**, built around one principle:

> **Make it impossible to submit a wrong application, and impossible to forget a deadline.**

Instead of a form that merely collects files, VisaDesk acts like a patient assistant: it knows each student's type and nationality, builds their exact checklist, coaches them through taking a good scan, checks the image quality before upload, and tells them precisely how many days of runway they have.

## 3. Users

| Persona | Needs |
|---|---|
| **Student** (new, continuing, Masters) | Know exactly what to send; do it from a phone in minutes; see status; fix only what was rejected; never miss a deadline. |
| **DOS staff** (reviewer) | See who is urgent; review fast with keyboard/swipe; give clear rejection reasons; package files for immigration in one click. |
| **DOS admin** | Manage staff accounts, requirement rules, fee settings, retention, reports. |
| **Immigration liaison** (optional, read-only) | Receive a clean, complete packet per student. |

## 4. What makes it different

1. **Visa Runway.** Every student sees one visual: today → *apply-by date* (expiry minus 30 days) → expiry → *penalty zone* (with a live "USD X owed if you stay" counter if expired). Staff see the same runway as a risk-sorted queue. Deadlines are the product's heartbeat.
2. **Scan Coach (client-side image intelligence).** Before upload the browser checks resolution, blur, glare, cropping and orientation, and **converts HEIC/PNG/PDF-page/camera captures into real JPG** automatically. The "JPG only" rule becomes invisible instead of a rejection reason. Students get instant, plain-language feedback ("Too blurry — hold steady and tap to focus").
3. **Rules as data, not code.** The checklist (which documents, for whom, fee exemptions, deadlines, penalty rate) lives in a **versioned rule set** the DOS admin can edit. The source notice is dated Nov 2024 and will change; the system must change with it without a redeploy. Each application records the rule-set version it was judged under.
4. **Per-document lifecycle.** An application is a bundle of documents, each with its own state. A rejection sends back **only that document**, with a reason chosen from templates plus free text. No "start over".
5. **Review Mode for staff.** A focused full-screen queue: document on the left, checklist and reason templates on the right, hotkeys (`A` approve, `R` reject, `N` next). Built for clearing 50 applications in a sitting.
6. **Immigration Packet.** One click produces a ZIP with consistently named JPGs, a generated **cover sheet PDF** (student summary, document manifest, visa dates, fee status) and a checksum manifest. Status flips to *Sent to immigration* with a timestamp.
7. **Low-bandwidth honesty.** Resumable uploads, automatic compression targets, draft autosave, and a PWA shell so a dropped connection never loses work. Students on prepaid data matter.
8. **Trustworthy by construction.** Private storage, short-lived signed URLs, row-level security, an append-only, hash-chained audit log, and an automatic retention sweep that deletes documents when the cycle ends.
9. **Nudges that respect attention.** Email by default; reminders escalate on a schedule (60, 30, 14, 7 days, and on expiry). Optional SMS/WhatsApp channel behind a provider interface (e.g. Africa's Talking) in a later phase.

## 5. Success measures

| Metric | Target (first full cycle) |
|---|---|
| Applications submitted complete on first try | ≥ 85% |
| Median time for a student to finish submission | ≤ 15 minutes |
| Median DOS review time per application | ≤ 3 minutes |
| Students expired without an application in flight | 0 undetected (all flagged ≥ 30 days ahead) |
| Illegal-stay penalty incidents caused by process delay | 0 |
| Documents retained past retention window | 0 |

## 6. Scope boundaries

**In scope:** student Student-Pass applications, document collection and validation, DOS review, status tracking, reminders, fee tracking (recorded, not collected), immigration packet export, audit log.

**Out of scope (v1):** collecting the visa fee online (fee is paid in shillings by the student; DOS records it), integration with Uganda's immigration systems, dependants' passes, non-student visas, academic records management.

## 7. Key principles

- **Clarity over cleverness**: plain English, short sentences, one action per screen on mobile.
- **Data minimisation**: collect only what the notice requires; delete when done.
- **Accessible by default**: WCAG 2.2 AA, works on a 3-year-old Android phone on 3G.
- **Configurable policy, stable core**: requirements change; the engine should not.
- **Every state is explainable**: any student or staff member can see *why* an application is in its current state.

## 8. Assumptions to confirm with the Dean of Students

1. Requirements in the Nov 2024 notice are still current (items 1–2, 4–8 official; items 3 and 9 added by students).
2. Whether Masters students also need item 8 (exam results) or only transcripts.
3. Whether Cavendish uses Google Workspace or Microsoft 365 for `@cavendish.ac.ug` (affects SSO vs email OTP).
4. Retention period (proposed default: delete 90 days after the application is *Sent to immigration* and the pass is confirmed).
5. Who counts as authorised staff; whether immigration receives packets by email or in person.
6. Brand assets (logo, colours) for Cavendish.

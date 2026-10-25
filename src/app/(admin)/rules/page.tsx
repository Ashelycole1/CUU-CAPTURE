import type { Metadata } from 'next';
import { requireActor } from '@/server/auth/current';
import { countMigratableDrafts, getPublishImpact, getRulesAdminData, toRuleSetInput } from '@/server/services/admin';
import { Card, CardBody, CardHeader, Chip, Table, TableContainer, TBody, TD, TH, THead, TR } from '@/components/ui';
import { RuleSetEditor } from '@/components/admin/rule-set-editor';
import { MigrateDraftsButton } from '@/components/admin/migrate-drafts';
import { admin as A } from '@/i18n/admin';
import { interpolate } from '@/i18n';
import { formatDateTime } from '@/domain/dates';

export const metadata: Metadata = { title: 'Rule sets' };

const STATUS_TONE = { published: 'ok', draft: 'info', retired: 'neutral' } as const;

/** FR-ADM-1: rule-set editor → diff against published → impact summary → publish → optional migrate. */
export default async function RulesPage() {
  const actor = await requireActor(['dos_admin']);
  const data = await getRulesAdminData(actor);
  const impact = data.draft ? await getPublishImpact(actor, data.draft.id) : null;
  const migratable = await countMigratableDrafts(actor);
  const nextVersion = data.draft?.version ?? (data.versions[0]?.version ?? 0) + 1;
  const source = data.draft ?? data.published;

  return (
    <div className="space-y-6">
      <header>
        <h1>{A.rules.title}</h1>
        <p className="mt-1 max-w-3xl text-ink-muted">{A.rules.intro}</p>
      </header>

      <section aria-labelledby="versions-h">
        <h2 id="versions-h" className="mb-3 text-xl">
          {A.rules.versionsHeading}
        </h2>
        <TableContainer>
          <Table>
            <THead>
              <TR>
                <TH>{A.rules.colVersion}</TH>
                <TH>{A.common.status}</TH>
                <TH>{A.rules.inFlight}</TH>
                <TH>{A.rules.colPublished}</TH>
              </TR>
            </THead>
            <TBody>
              {data.versions.map((v) => (
                <TR key={v.id}>
                  <TD className="font-mono tabular">{interpolate(A.rules.version, { version: v.version })}</TD>
                  <TD>
                    <Chip tone={STATUS_TONE[v.status]}>{A.rules[v.status]}</Chip>
                  </TD>
                  <TD className="font-mono tabular">{v.applicationCount}</TD>
                  <TD>{v.publishedAt ? formatDateTime(v.publishedAt) : '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableContainer>
      </section>

      {impact && (
        <section aria-labelledby="impact-h" className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={<span id="impact-h">{A.rules.impactHeading}</span>} />
            <CardBody>
              <ul className="list-disc space-y-1 pl-5">
                {impact.summary.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={impact.base ? interpolate(A.rules.diffHeading, { version: impact.base.version }) : A.rules.diffHeadingFirst} />
            <CardBody>
              {impact.diff.empty ? (
                <p className="text-ink-muted">{A.rules.diffNone}</p>
              ) : (
                <dl className="space-y-3 text-sm">
                  {impact.diff.fields.map((f) => (
                    <div key={f.key}>
                      <dt className="font-semibold">{f.label}</dt>
                      <dd>
                        <del className="text-bad">{f.from}</del> → <ins className="text-ok no-underline">{f.to}</ins>
                      </dd>
                    </div>
                  ))}
                  {impact.diff.docsAdded.map((d) => (
                    <div key={`a-${d.code}`}>
                      <dt className="font-semibold">+ {d.name}</dt>
                      <dd className="text-ok">{A.rules.addDocument}</dd>
                    </div>
                  ))}
                  {impact.diff.docsRemoved.map((d) => (
                    <div key={`r-${d.code}`}>
                      <dt className="font-semibold">− {d.name}</dt>
                      <dd className="text-bad">{A.common.remove}</dd>
                    </div>
                  ))}
                  {impact.diff.docsChanged.map((d) => (
                    <div key={`c-${d.code}`}>
                      <dt className="font-semibold">{d.name}</dt>
                      {d.changes.map((c) => (
                        <dd key={c.key}>
                          {c.label}: <del className="text-bad">{c.from}</del> → <ins className="text-ok no-underline">{c.to}</ins>
                        </dd>
                      ))}
                    </div>
                  ))}
                </dl>
              )}
            </CardBody>
          </Card>
        </section>
      )}

      {migratable.count > 0 && migratable.toVersion !== null && (
        <Card>
          <CardHeader title={A.rules.migrateHeading} description={interpolate(A.rules.migrateBody, { count: migratable.count, version: migratable.toVersion })} />
          <CardBody>
            <MigrateDraftsButton count={migratable.count} version={migratable.toVersion} />
          </CardBody>
        </Card>
      )}

      <section aria-labelledby="editor-h">
        <h2 id="editor-h" className="mb-3 text-xl">
          {data.draft
            ? `${A.rules.editDraft} (${interpolate(A.rules.version, { version: data.draft.version })})`
            : data.published
              ? interpolate(A.rules.newDraft, { version: data.published.version })
              : A.rules.editDraft}
        </h2>
        {source ? (
          <RuleSetEditor
            key={data.draft?.id ?? 'new'}
            draftId={data.draft?.id ?? null}
            draftVersion={nextVersion}
            initial={toRuleSetInput(source)}
            canPublish={!!impact}
          />
        ) : (
          <p className="text-ink-muted">{A.common.empty}</p>
        )}
      </section>
    </div>
  );
}

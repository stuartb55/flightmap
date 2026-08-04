import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/**
 * The raw-anchor pattern is drift rather than a design choice, so the lint rule
 * is what keeps it from returning. These cases are the ones the sweep found.
 *
 * `src` is otherwise browser-only and its tsconfig carries no Node types, so
 * the one Node global this needs is declared rather than pulled in wholesale.
 */
declare const process: { cwd(): string }

// The flat config lives at the repository root, which is the working directory
// for a root `npm run test` and two levels up for a workspace run.
const repositoryRoot = process.cwd().replace(/[/\\]apps[/\\]web$/, '')
const linter = new ESLint({ cwd: repositoryRoot })

async function lint(source: string) {
  const [result] = await linter.lintText(source, {
    filePath: `${repositoryRoot}/apps/web/src/lint-fixture.tsx`,
  })
  return (result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-syntax')
}

// ESLint parses each fixture from cold, which is slower than a component test
// and slower still on a loaded CI runner.
describe('internal navigation lint rule', { timeout: 30_000 }, () => {
  it('rejects a raw internal anchor and names the replacement', async () => {
    const messages = await lint('export const Drift = () => <a href="/history">History</a>\n')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('<Link to="…"> from lib/router')
  })

  it('rejects an interpolated internal anchor and a conditional one', async () => {
    const template = await lint(
      'export const Drift = ({ icao }: { icao: string }) => <a href={`/aircraft/${icao}`}>Profile</a>\n',
    )
    expect(template).toHaveLength(1)
    expect(template[0]?.message).toContain('<Link to="…"> from lib/router')

    const conditional = await lint(
      'export const Drift = ({ own }: { own: boolean }) => <a href={own ? "/history" : "/insights"}>Go</a>\n',
    )
    expect(conditional).toHaveLength(2)
  })

  it('rejects assigning location.href, with or without the window prefix', async () => {
    const qualified = await lint('export const go = () => { window.location.href = "/history" }\n')
    expect(qualified).toHaveLength(1)
    expect(qualified[0]?.message).toContain('navigate() from lib/router')

    const bare = await lint('export const go = () => { location.href = "/history" }\n')
    expect(bare).toHaveLength(1)
  })

  it('leaves download anchors, external links, and in-page anchors alone', async () => {
    const messages = await lint(
      [
        'export const Fine = ({ id }: { id: string }) => (',
        '  <>',
        '    <a download href={`/api/v1/exports/sessions/${id}`}>CSV</a>',
        '    <a download href="/api/v1/exports/insights">CSV</a>',
        '    <a href="https://openfreemap.org/">Attribution</a>',
        '    <a href="#main-content">Skip to main content</a>',
        '  </>',
        ')\n',
      ].join('\n'),
    )
    expect(messages).toEqual([])
  })
})

/**
 * README markdown → sanitized HTML for the repository detail view.
 *
 * Pipeline: marked (GFM) → DOMPurify.sanitize → best-effort URL fixup inside
 * a detached DOM copy → serialized HTML. The output is always inserted under
 * the `.marketReadme` scope class (see ManagePluginsTab.module.css), so every
 * README element is styled by semantic tokens only and never leaks layout
 * outside the detail card.
 *
 * Relative links and images resolve against the GitHub convention for a README
 * living at the repository root of the default branch (links under
 * `/blob/<branch>/`, images under `/raw/<branch>/`). Absolute http(s) and
 * protocol-relative URLs are kept verbatim and opened in a new tab; in-page
 * `#fragment` anchors and non-http schemes stay untouched.
 *
 * `marked` is environment-neutral, and `dompurify` resolves to the browser
 * factory or a bound instance depending on whether a window exists at module
 * evaluation — this module is only ever invoked by the browser half (and its
 * jsdom specs), never by the node-facing assembly specs.
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** Resolution bases for relative README URLs (GitHub README conventions). */
export interface ReadmeUrlContext {
  /** Browser URL of the repository, e.g. https://github.com/owner/repo. */
  readonly url: string
  /** Default branch name used to build the `/blob` and `/raw` bases. */
  readonly defaultBranch: string
}

/** http(s) or protocol-relative URL (opened in a new tab). */
const EXTERNAL_HTTP = /^(?:https?:)?\/\//i

/** Any explicit URI scheme or protocol-relative URL (never resolved). */
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/** Whether a link is an in-page fragment of the README itself. */
function isFragment(value: string): boolean {
  return value.startsWith('#')
}

/** Best-effort resolution of one relative reference against a base URL. */
function resolveRelative(value: string, base: string): string {
  try {
    return new URL(value, base).href
  } catch {
    return value
  }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/** URL-safe branch path (each `/` segment encoded independently). */
function branchPath(branch: string): string {
  return branch.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/**
 * Render one raw README markdown document to sanitized HTML, rewriting
 * relative links/images against the repository's GitHub bases and hardening
 * every external link for `target="_blank"` navigation.
 */
export function renderReadmeHtml(markdown: string, context: ReadmeUrlContext): string {
  const raw = typeof marked.parse === 'function'
    ? marked.parse(markdown, { async: false, gfm: true })
    : String(markdown)
  const cleaned = DOMPurify.sanitize(String(raw))

  const root = document.createElement('div')
  root.innerHTML = cleaned

  const rootUrl = stripTrailingSlash(context.url)
  const branch = branchPath(context.defaultBranch)
  const blobBase = `${rootUrl}/blob/${branch}/`
  const rawBase = `${rootUrl}/raw/${branch}/`

  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = anchor.getAttribute('href')
    if (href === null || isFragment(href)) continue
    if (ABSOLUTE_URL.test(href)) {
      if (EXTERNAL_HTTP.test(href)) {
        anchor.setAttribute('target', '_blank')
        anchor.setAttribute('rel', 'noreferrer')
      }
      continue
    }
    anchor.setAttribute('href', resolveRelative(href, blobBase))
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noreferrer')
  }

  for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const src = image.getAttribute('src')
    if (src === null || ABSOLUTE_URL.test(src)) continue
    image.setAttribute('src', resolveRelative(src, rawBase))
  }

  return root.innerHTML
}

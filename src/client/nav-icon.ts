/**
 * Phone glyph for the settings-nav cell. The shell's navIcon map is hardcoded
 * to five official section ids and falls back to a gear for everything else,
 * so a third-party section can only restyle its own cell at runtime: find the
 * nav button whose label matches and swap the icon wrapper's contents. The
 * css-module hashes change per build, but the local class names (navCell,
 * navLabel, navIcon) survive, so substring selectors stay stable. If the
 * markup ever changes, this silently no-ops and the gear returns.
 *
 * Idempotency is decided by a marker attribute, NOT by comparing innerHTML:
 * the serializer rewrites self-closing tags, so a string comparison never
 * matches and a MutationObserver would loop on its own writes forever —
 * exactly the UI freeze 0.1.8 shipped.
 */
const NAV_ICON_MARKER = 'data-dshr-phone'

function navIconSvg(): Element {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute(NAV_ICON_MARKER, '')
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  rect.setAttribute('x', '4.5')
  rect.setAttribute('y', '1.5')
  rect.setAttribute('width', '7')
  rect.setAttribute('height', '13')
  rect.setAttribute('rx', '1.8')
  const bar = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  bar.setAttribute('d', 'M7 11.8h2')
  svg.append(rect, bar)
  return svg
}

export function patchNavIcon(label: string): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  let running = false
  const apply = (): void => {
    if (running) return
    running = true
    try {
      for (const cell of Array.from(document.querySelectorAll('button[class*="navCell"]'))) {
        const labelEl = cell.querySelector('[class*="navLabel"]')
        if (!labelEl || labelEl.textContent !== label) continue
        const icon = cell.querySelector('[class*="navIcon"]')
        // Marker check: once our svg is in place, skip — no DOM write, so the
        // observer never re-fires from our own patch.
        if (!icon || icon.querySelector(`svg[${NAV_ICON_MARKER}]`)) continue
        icon.replaceChildren(navIconSvg())
      }
    } finally {
      running = false
    }
  }
  const observer = new MutationObserver(apply)
  observer.observe(document.body, { childList: true, subtree: true })
  apply()
  return () => observer.disconnect()
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { patchNavIcon } from '../src/client/nav-icon.ts'

/**
 * The icon patch must be idempotent under observer re-entry: its own DOM
 * write fires the MutationObserver again, and a patch that still decided to
 * write would loop forever and freeze the whole UI (exactly what 0.1.8 did:
 * innerHTML round-trips re-serialize, so a string comparison never matched).
 */
test('nav icon patch writes exactly once per cell', () => {
  let writes = 0
  let replaced = false
  let observerCallback: (() => void) | undefined

  const icon = {
    querySelector(selector: string): unknown {
      return replaced && selector.includes('data-dshr-phone') ? {} : null
    },
    replaceChildren(): void {
      writes += 1
      replaced = true
    },
  }
  const cell = {
    querySelector(selector: string): unknown {
      if (selector.includes('navLabel')) return { textContent: '手机远程' }
      if (selector.includes('navIcon')) return icon
      return null
    },
  }

  const globalScope = globalThis as unknown as Record<string, unknown>
  const savedDocument = globalScope.document
  const savedObserver = globalScope.MutationObserver
  globalScope.document = {
    querySelectorAll: () => [cell],
    createElementNS: () => ({ setAttribute: () => {}, append: () => {} }),
    body: {},
  }
  globalScope.MutationObserver = class {
    constructor(callback: () => void) {
      observerCallback = callback
    }
    observe(): void {}
    disconnect(): void {}
  }

  try {
    const dispose = patchNavIcon('手机远程')
    assert.equal(writes, 1, 'initial apply writes once')

    // Simulate the observer firing from our own write, repeatedly.
    observerCallback?.()
    observerCallback?.()
    observerCallback?.()
    assert.equal(writes, 1, 'observer re-entry performs no further writes')

    dispose()
  } finally {
    globalScope.document = savedDocument
    globalScope.MutationObserver = savedObserver
  }
})

test('nav icon patch ignores cells with other labels', () => {
  let writes = 0
  let observerCallback: (() => void) | undefined
  const icon = {
    querySelector: () => null,
    replaceChildren(): void {
      writes += 1
    },
  }
  const otherCell = {
    querySelector(selector: string): unknown {
      if (selector.includes('navLabel')) return { textContent: '通用' }
      if (selector.includes('navIcon')) return icon
      return null
    },
  }

  const globalScope = globalThis as unknown as Record<string, unknown>
  const savedDocument = globalScope.document
  const savedObserver = globalScope.MutationObserver
  globalScope.document = {
    querySelectorAll: () => [otherCell],
    createElementNS: () => ({ setAttribute: () => {}, append: () => {} }),
    body: {},
  }
  globalScope.MutationObserver = class {
    constructor(callback: () => void) {
      observerCallback = callback
    }
    observe(): void {}
    disconnect(): void {}
  }

  try {
    const dispose = patchNavIcon('手机远程')
    observerCallback?.()
    assert.equal(writes, 0, 'foreign cells are never touched')
    dispose()
  } finally {
    globalScope.document = savedDocument
    globalScope.MutationObserver = savedObserver
  }
})

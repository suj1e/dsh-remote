import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, readVolatile } from '../src/config.ts'

test('enabled parses as a volatile reference when set', () => {
  const result = Config['~standard'].validate({ enabled: false, port: 9000 })
  if (result.issues) throw new Error(JSON.stringify(result.issues))
  const value = result.value as { enabled: unknown; port: number }
  // A set volatile field materializes as a stable reference read via .get().
  assert.equal(readVolatile(value.enabled as never), false)
  assert.equal(value.port, 9000)
})

test('enabled default stays ordinary true', () => {
  const result = Config['~standard'].validate({})
  if (result.issues) throw new Error(JSON.stringify(result.issues))
  const value = result.value as { enabled: unknown }
  assert.equal(readVolatile(value.enabled as never), true)
})

test('readVolatile passes plain values through', () => {
  assert.equal(readVolatile(true), true)
  assert.equal(readVolatile(false), false)
  assert.equal(readVolatile(undefined), undefined)
})

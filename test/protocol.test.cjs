const assert = require('node:assert/strict')
const test = require('node:test')

const {
  EZD_SESSION_MODES,
  parseProtocolRequest,
  takeProtocolSecret,
} = require('../electron/protocol.cjs')

const token = 'session-token-abc123'
const proxy = 'aHR0cHM6Ly9lemQtcHJveHkua2cuc3RyYXouZ292LnBsL1NlcnZpY2UvRXpkUHJveHkuc3Zj'
const serviceUrl = 'https://ezd-proxy.kg.straz.gov.pl/Service/EzdProxy.svc'

test('parses the supported EZD operation modes', () => {
  assert.deepEqual(EZD_SESSION_MODES, {
    DEFAULT: 0,
    EDIT: 0,
    PRINT: 1,
    SIGN: 2,
    SIGN_BATCH: 5,
    SIGN_BATCH_V2: 7,
  })

  for (const [raw, parameterName] of [
    [`ezd://${token}/${proxy}/ModeParam=2`, 'ModeParam'],
    [`ezd://${token}/${proxy}?ModeParam=2`, 'ModeParam'],
    [`ezd:\\${token}\\${proxy}\\ModeParam=2`, 'ModeParam'],
    [`ezd://${token}/${proxy}/Mode=7`, 'Mode'],
  ]) {
    const request = parseProtocolRequest(raw)
    assert.deepEqual(request, {
      kind: 'ezd-session',
      scheme: 'ezd',
      serviceUrl,
      mode: parameterName === 'Mode' ? 7 : 2,
      parameters: { [parameterName]: parameterName === 'Mode' ? 7 : 2 },
    })
  }
})

test('keeps EZD tokens out of parsed requests and releases them once', () => {
  const request = parseProtocolRequest(`ezd://${token}/${proxy}/ModeParam=2`)

  assert.doesNotMatch(JSON.stringify(request), new RegExp(token))
  assert.deepEqual(takeProtocolSecret(request), { authToken: token })
  assert.equal(takeProtocolSecret(request), null)
})

test('defaults parameterless EZD sessions to edit mode', () => {
  assert.deepEqual(parseProtocolRequest(`ezd://${token}/${proxy}`), {
    kind: 'ezd-session',
    scheme: 'ezd',
    serviceUrl,
    mode: EZD_SESSION_MODES.EDIT,
    parameters: {},
  })
})

test('rejects ambiguous, malformed, and untrusted EZD operation parameters', () => {
  for (const raw of [
    `ezd://${token}/${proxy}/ModeParam=2?Mode=2`,
    `ezd://${token}/${proxy}?ModeParam=2&Mode=2`,
    `ezd://${token}/${proxy}/ModeParam=%E0%A4%A`,
    `ezd://${token}/${proxy}?ModeParam=2&authToken=other-secret`,
    `ezd://${token}/${proxy}/ModeParam=3`,
  ]) {
    assert.equal(parseProtocolRequest(raw)?.kind, 'invalid')
  }
})

test('rejects EZD fragments before storing a token', () => {
  for (const raw of [
    `ezd://${token}/${proxy}/ModeParam=2#Mode=5`,
    `ezd://${token}/${proxy}/ModeParam=2#authToken=other-secret`,
    `ezd://${token}/${proxy}/ModeParam=2#`,
  ]) {
    assert.equal(parseProtocolRequest(raw)?.kind, 'invalid')
  }
})

test('rejects malformed EZD authority separators', () => {
  for (const raw of [
    `ezd:/${token}/${proxy}/ModeParam=2`,
    `ezd:///${token}/${proxy}/ModeParam=2`,
    `ezd:/\\${token}\\${proxy}\\ModeParam=2`,
    `ezd:\\${token}/${proxy}\\ModeParam=2`,
  ]) {
    assert.equal(parseProtocolRequest(raw)?.kind, 'invalid')
  }
  assert.equal(
    parseProtocolRequest(`ezd:/${token}/${proxy}/ModeParam=2`)?.code,
    'EZD_PROTOCOL_STRUCTURE',
  )
})

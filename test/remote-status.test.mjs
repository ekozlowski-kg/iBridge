import assert from 'node:assert/strict'
import test from 'node:test'

import { remoteStatusView } from '../dist/remote-status.js'

test('shows the exact failed EZD operation and status', () => {
  const view = remoteStatusView({
    status: 'editing',
    syncStatus: 'error',
    lastError: {
      operation: 'AddInUploadFile',
      ezdStatus: 1,
      message: 'Usługa EZD zwróciła status 1.',
    },
  })
  assert.deepEqual(view, {
    className: 'error',
    title: 'Błąd synchronizacji',
    detail: 'AddInUploadFile · status 1 · Usługa EZD zwróciła status 1.',
  })
})

test('shows an HTTP transport status when no EZD domain status exists', () => {
  const view = remoteStatusView({
    status: 'editing',
    syncStatus: 'error',
    lastError: { operation: 'AddInUploadFile', httpStatus: 503, message: 'Brak połączenia.' },
  })
  assert.equal(view.detail, 'AddInUploadFile · HTTP 503 · Brak połączenia.')
})

test('shows the latest successful synchronization while editing remains open', () => {
  const view = remoteStatusView({
    status: 'editing',
    syncStatus: 'synced',
    lastSyncedAt: '2026-08-31T10:00:00.000Z',
  })
  assert.equal(view.className, 'synced')
  assert.equal(view.title, 'Zapisano w EZD')
  assert.match(view.detail, /Ostatnia poprawna synchronizacja/)
})

test('maps pending, syncing, idle, and sent states to concise Polish copy', () => {
  assert.equal(remoteStatusView({ status: 'editing', syncStatus: 'idle' }).title, 'Oczekuje na zapis')
  assert.equal(remoteStatusView({ status: 'editing', syncStatus: 'pending' }).title, 'Oczekuje na stabilny zapis')
  assert.equal(remoteStatusView({ status: 'editing', syncStatus: 'syncing' }).title, 'Synchronizacja…')
  assert.equal(remoteStatusView({ status: 'sent' }).title, 'Edycja zakończona w EZD')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { homeSession, compactStatus, connectionLabel } from '../dist/status-model.js'

test('home keeps an unresolved older failure visible instead of hiding it behind a newer success', () => {
  const older = {id:'older',remote:{syncStatus:'error',connectionStatus:'needs-reopen'},updatedAt:'2026-01-01'}
  const newer = {id:'newer',remote:{syncStatus:'synced',lastUploadAt:'2026-02-01',connectionStatus:'active'}}
  assert.equal(homeSession([newer,older]).id,'older')
  assert.equal(compactStatus(older).tone,'error')
})
test('a clean download is not presented as an upload; active changes and acknowledged sends differ', () => {
  const s = {remote:{connectionStatus:'active',syncStatus:'idle'}}
  assert.equal(compactStatus(s).title,'Dokument jest otwarty')
  s.remote.syncStatus='syncing';assert.equal(compactStatus(s).tone,'sending')
  s.remote.syncStatus='synced';s.remote.lastUploadAt='2026-01-01';assert.equal(compactStatus(s).tone,'success')
})
test('expired sessions and modified historical copies never claim active synchronization', () => {
  const s = {remote:{connectionStatus:'needs-reopen',recoveryRequired:true,syncStatus:'synced'}}
  assert.equal(compactStatus(s).tone,'error')
  assert.equal(connectionLabel(s),'Brak aktywnej sesji')
  s.remote.recoveryRequired=false;assert.equal(compactStatus(s).tone,'idle')
})
test('confirmed upload with failed close is shown as a close problem, not a rejected upload', () => {
  const s = {remote:{connectionStatus:'active',syncStatus:'synced',finishStatus:'error'}}
  const view=compactStatus(s)
  assert.equal(view.title,'Sesja nie została zamknięta')
  assert.match(view.text,/Plik jest zapisany w EZD/)
})

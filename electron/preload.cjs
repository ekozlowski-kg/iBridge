const { contextBridge, ipcRenderer, webUtils } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('mostEzd', {
  getState: () => ipcRenderer.invoke('state:get'),
  setWindowMode: mode => ipcRenderer.invoke('window:mode', mode),
  getUpdates: () => ipcRenderer.invoke('updates:get'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  openRelease: () => ipcRenderer.invoke('updates:open'),
  openEzdAccount: () => ipcRenderer.invoke('account:open'),
  onUpdatesChanged: callback => subscribe('updates-changed', callback),
  chooseDocument: () => ipcRenderer.invoke('document:choose'),
  importPath: (filePath) => ipcRenderer.invoke('document:import-path', filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openInEditor: (sessionId) => ipcRenderer.invoke('document:open-editor', sessionId),
  openEzdCase: (sessionId) => ipcRenderer.invoke('document:open-ezd-case', sessionId),
  saveVersion: (sessionId) => ipcRenderer.invoke('document:save-version', sessionId),
  readEditableDocument: (sessionId) => ipcRenderer.invoke('document:read-editable', sessionId),
  saveEditableDocument: (sessionId, text) => ipcRenderer.invoke('document:save-editable', sessionId, text),
  replaceDocument: (sessionId) => ipcRenderer.invoke('document:replace', sessionId),
  syncToEzd: (sessionId) => ipcRenderer.invoke('document:sync-ezd', sessionId),
  finishEzdSession: (sessionId) => ipcRenderer.invoke('document:finish-ezd', sessionId),
  revealDocument: (sessionId, versionId = null) => ipcRenderer.invoke('document:reveal', sessionId, versionId),
  compareSession: (sessionId) => ipcRenderer.invoke('compare:session', sessionId),
  chooseCompareFiles: () => ipcRenderer.invoke('compare:choose'),
  chooseEditor: () => ipcRenderer.invoke('settings:choose-editor'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  getLaunchAtLogin: () => ipcRenderer.invoke('settings:get-launch-at-login'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('settings:set-launch-at-login', enabled),
  revealStorage: () => ipcRenderer.invoke('settings:reveal-storage'),
  testService: (url) => ipcRenderer.invoke('settings:test-service', url),
  approveSignature: (requestId, pin) => ipcRenderer.invoke('signature:approve', requestId, pin),
  cancelSignature: (requestId) => ipcRenderer.invoke('signature:cancel', requestId),
  onStateChanged: (callback) => subscribe('state-changed', callback),
  onProtocolMessage: (callback) => subscribe('protocol-message', callback),
  onSignatureRequested: (callback) => subscribe('signature-requested', callback),
  onSignatureProgress: (callback) => subscribe('signature-progress', callback),
  onSignatureFinished: (callback) => subscribe('signature-finished', callback),
})

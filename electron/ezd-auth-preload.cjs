const { contextBridge, ipcRenderer } = require('electron')
const channel = process.argv.find(arg => arg.startsWith('--ezd-auth-channel='))?.slice('--ezd-auth-channel='.length)
contextBridge.exposeInMainWorld('ezdAuth', {
  submit: value => ipcRenderer.invoke(channel, value),
})

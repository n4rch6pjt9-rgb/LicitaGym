// Evita pop-up "EPIPE: broken pipe" quando o terminal que abriu o app é fechado
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return // saída fechada: ignora
    throw err
  })
}
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})

import './load-env'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { registerAuthIpc } from './ipc/auth'
import { registerAdminIpc } from './ipc/admin'
import { registerProviderIpc } from './ipc/providers'
import { registerAlertsIpc } from './ipc/alerts'
import { registerSyncsIpc } from './ipc/syncs'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.setPath('userData', join(app.getPath('appData'), 'kuib-harness'))

app.whenReady().then(() => {
  registerAuthIpc()
  registerAdminIpc()
  registerProviderIpc()
  registerAlertsIpc()
  registerSyncsIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

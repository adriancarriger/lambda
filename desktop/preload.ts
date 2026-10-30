/**
 * The one thing the Mac app adds to the setup pages: the native folder
 * picker, as `window.lambda.pickFolder()`. The main process answers it only
 * for the local mothership's own frame.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('lambda', {
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('lambda:pick-folder'),
});

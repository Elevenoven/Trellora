import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@mantine/core/styles.css'
import Application from './Application.tsx'
import './styles/variables.css'
import './styles/codeBlockEditor.css'
import './styles/theme.css'
import { applyColorScheme, getDocumentLightColorScheme, getDocumentTheme } from './utils/theme'
import { initializeStartupSplash, showStartupError } from './utils/startupSplash'
import { setAppLanguage } from './i18n'

applyColorScheme(getDocumentTheme(), getDocumentLightColorScheme())
setAppLanguage(document.documentElement.lang)
initializeStartupSplash()

// The first HTML frame is already visible while the main process scans the library.
void (window.electronAPI?.waitForStartup?.() ?? Promise.resolve()).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Application />
    </StrictMode>,
  )
}).catch(() => showStartupError())

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import MixerWindowApp from './MixerWindowApp.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import './index.css'

const searchParams = new URLSearchParams(window.location.search)
const windowRole = searchParams.get('window')
const RootComponent = windowRole === 'mixer' ? MixerWindowApp : App

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <ErrorBoundary>
            <RootComponent />
        </ErrorBoundary>
    </React.StrictMode>,
)

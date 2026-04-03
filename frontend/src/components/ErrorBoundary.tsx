import React from "react";
import { nativeBridge } from "../services/NativeBridge";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Caught render error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex flex-col bg-daw-dark text-white">
          {/* Title bar with window controls - always accessible */}
          <div
            className="flex items-center justify-between h-9 bg-neutral-900 border-b border-neutral-700 shrink-0 select-none"
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          >
            <div className="px-3 text-xs text-neutral-400">OpenStudio - Error</div>
            <div
              className="flex items-center h-full"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <button
                onClick={() => nativeBridge.minimizeWindow()}
                className="h-full px-3.5 flex items-center justify-center text-neutral-400 hover:bg-neutral-700/60 hover:text-white transition-colors"
                title="Minimize"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12" /></svg>
              </button>
              <button
                onClick={() => nativeBridge.maximizeWindow()}
                className="h-full px-3.5 flex items-center justify-center text-neutral-400 hover:bg-neutral-700/60 hover:text-white transition-colors"
                title="Maximize"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
              </button>
              <button
                onClick={() => nativeBridge.closeWindow()}
                className="h-full px-3.5 flex items-center justify-center text-neutral-400 hover:bg-red-600 hover:text-white transition-colors"
                title="Close"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          </div>

          {/* Error message */}
          <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
            <div className="text-red-400 text-lg font-semibold">Something went wrong</div>
            <div className="max-w-lg text-center text-sm text-neutral-400">
              An unexpected error occurred. You can try reloading the app.
            </div>
            <pre className="max-w-2xl max-h-48 overflow-auto text-xs text-red-300 bg-neutral-900 rounded p-4 border border-neutral-700">
              {this.state.error?.message}
              {this.state.error?.stack && "\n\n" + this.state.error.stack}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2 bg-daw-accent hover:bg-blue-600 text-white rounded text-sm font-medium transition-colors"
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

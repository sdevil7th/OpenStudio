import { useShallow } from "zustand/shallow";
import { nativeBridge } from "../services/NativeBridge";
import { useDAWStore } from "../store/useDAWStore";
import { Button, Modal, ModalContent, ModalFooter, ModalHeader } from "./ui";

const IS_WINDOWS = navigator.platform.startsWith("Win") || navigator.userAgent.includes("Windows");

const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";

function Step({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-daw-accent flex items-center justify-center text-xs font-bold text-white">
        {number}
      </div>
      <div className="text-sm text-daw-text leading-relaxed">{children}</div>
    </div>
  );
}

function CodeSnip({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-neutral-900 text-green-400 text-xs px-1.5 py-0.5 rounded font-mono">
      {children}
    </code>
  );
}

export default function AiToolsSetupModal() {
  const { showAiToolsSetup, closeAiToolsSetup, installAiTools, aiToolsStatus } = useDAWStore(
    useShallow((s) => ({
      showAiToolsSetup: s.showAiToolsSetup,
      closeAiToolsSetup: s.closeAiToolsSetup,
      installAiTools: s.installAiTools,
      aiToolsStatus: s.aiToolsStatus,
    })),
  );

  if (!showAiToolsSetup) return null;

  const isPythonMissing = aiToolsStatus.state === "pythonMissing";
  const hasInstallError = !isPythonMissing && Boolean(aiToolsStatus.error);
  const pythonDetected = aiToolsStatus.pythonDetected;
  const errorTitle =
    aiToolsStatus.state === "cancelled" ? "AI tools setup was cancelled" : "AI tools setup needs attention";
  const retryGuidance = pythonDetected
    ? "Python was detected, so you can usually retry from this window. If the same error comes back, restart OpenStudio and reopen this setup window before trying again."
    : "OpenStudio could not confirm a usable Python installation yet. Install Python first, restart OpenStudio, then reopen this setup window and retry.";

  const handleDownloadPython = async () => {
    await nativeBridge.openExternalURL(PYTHON_DOWNLOAD_URL);
  };

  const handleRetry = async () => {
    closeAiToolsSetup();
    await installAiTools();
  };

  return (
    <Modal isOpen={showAiToolsSetup} onClose={closeAiToolsSetup} size="md">
      <ModalHeader title="AI Tools Setup" />
      <ModalContent>
        <div className="space-y-5">
          <div className="rounded bg-daw-dark p-3 space-y-1">
            <p className="text-sm font-medium text-daw-text">What is this?</p>
            <p className="text-xs text-daw-text-secondary leading-relaxed">
              AI Tools enables <span className="text-daw-text">Stem Separation</span> - splitting a
              clip into individual tracks like Vocals, Drums, Bass, Guitar, and more. It installs a
              small Python environment in the background the first time and downloads the AI model
              (~200 MB).
            </p>
          </div>

          <div className="rounded border border-neutral-800 bg-neutral-950/60 p-3 space-y-1">
            <p className="text-sm font-medium text-daw-text">Recommended setup</p>
            <p className="text-xs text-daw-text-secondary leading-relaxed">
              Use the official Python installer for your operating system, then reopen OpenStudio and
              click <span className="text-daw-text font-medium">Retry After Python Install</span>.
              You do not need to configure anything manually beyond the steps below.
            </p>
          </div>

          {isPythonMissing ? (
            <div className="rounded border border-yellow-600/40 bg-yellow-950/30 p-3 space-y-1">
              <p className="text-sm font-semibold text-yellow-400">Python is required</p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                OpenStudio could not find Python 3.10 or newer on this machine. Python is needed to
                run the AI model - it stays isolated in its own environment and will not affect
                anything else on your system.
              </p>
            </div>
          ) : hasInstallError ? (
            <div className="rounded border border-red-600/40 bg-red-950/30 p-3 space-y-2">
              <p className="text-sm font-semibold text-red-400">{errorTitle}</p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                OpenStudio could not finish the AI tools setup. Error reported:{" "}
                <span className="text-daw-text">{aiToolsStatus.error}</span>
              </p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                Python detected:{" "}
                <span className={pythonDetected ? "text-green-400" : "text-yellow-300"}>
                  {pythonDetected ? "Yes" : "No"}
                </span>
              </p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">{retryGuidance}</p>
            </div>
          ) : null}

          <div className="space-y-1">
            <p className="text-xs font-medium text-daw-text-secondary uppercase tracking-wide">
              How to get started
            </p>
            <div className="space-y-3 pt-1">
              {IS_WINDOWS ? (
                <>
                  <Step number={1}>
                    Click <span className="text-daw-text font-medium">Download Python</span> below.
                    Your browser will open the official Python website. Download the latest{" "}
                    <span className="text-daw-text font-medium">Python 3.x</span> installer
                    for <span className="text-daw-text font-medium">Windows 64-bit</span>. If the
                    website offers multiple files, choose the standard Windows installer, not the
                    source code.
                  </Step>
                  <Step number={2}>
                    Open the downloaded installer. On the very first screen, look for the checkbox
                    that says{" "}
                    <span className="text-yellow-400 font-semibold">
                      check "Add python.exe to PATH"
                    </span>
                    . Turn that checkbox on before clicking Install. This simply allows OpenStudio to
                    find Python automatically later.
                  </Step>
                  <Step number={3}>
                    Click the normal install option and wait for setup to finish. If Windows asks for
                    permission, choose <span className="text-daw-text font-medium">Yes</span>.
                  </Step>
                  <Step number={4}>
                    After the installer finishes,{" "}
                    <span className="text-daw-text font-medium">restart OpenStudio</span> so it can
                    detect the new Python installation. If OpenStudio is already open, close it fully
                    and open it again.
                  </Step>
                  <Step number={5}>
                    Click <span className="text-daw-text font-medium">Install AI Tools</span> here
                    (or click the <CodeSnip>AI</CodeSnip> button in the toolbar again). OpenStudio
                    will set up the environment and download the model automatically.
                  </Step>
                  <Step number={6}>
                    If OpenStudio still says Python is missing, run the Python installer again and
                    make sure the <span className="text-yellow-400 font-semibold">Add to PATH</span>{" "}
                    box was enabled, then restart OpenStudio one more time.
                  </Step>
                </>
              ) : (
                <>
                  <Step number={1}>
                    Click <span className="text-daw-text font-medium">Download Python</span> below.
                    This opens the official Python website. Download the latest{" "}
                    <span className="text-daw-text font-medium">Python 3.x</span> installer for
                    macOS. This is the easiest option for most people.
                  </Step>
                  <Step number={2}>
                    Open the downloaded installer package and follow the normal install steps. If
                    macOS asks for permission to open the installer, allow it and continue.
                  </Step>
                  <Step number={3}>
                    After installing,{" "}
                    <span className="text-daw-text font-medium">restart OpenStudio</span> so it
                    picks up the new Python. If OpenStudio is already open, quit it completely and
                    open it again.
                  </Step>
                  <Step number={4}>
                    Click <span className="text-daw-text font-medium">Install AI Tools</span> - the
                    environment and model (~200 MB) will download in the background.
                  </Step>
                  <Step number={5}>
                    Advanced option: if you already use Homebrew, you can install Python from
                    Terminal with <CodeSnip>brew install python3</CodeSnip>, then restart OpenStudio
                    and retry from this window.
                  </Step>
                  <Step number={6}>
                    If OpenStudio still cannot find Python after installing it, restart your Mac once
                    and then reopen OpenStudio before retrying.
                  </Step>
                </>
              )}
            </div>
          </div>

          <div className="border-t border-neutral-800 pt-3 space-y-2">
            <p className="text-xs text-daw-text-secondary leading-relaxed">
              Already installed Python and restarted OpenStudio?{" "}
              <button
                className="text-daw-accent underline underline-offset-2 hover:text-blue-300"
                onClick={() => void handleRetry()}
              >
                Click here to retry
              </button>
              .
            </p>
            <p className="text-xs text-daw-text-secondary leading-relaxed">
              After Python is detected, OpenStudio will continue the rest of the AI tools setup in
              the background. You can keep using the app while that runs.
            </p>
          </div>
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="ghost" onClick={closeAiToolsSetup}>
          Close
        </Button>
        <Button variant="secondary" onClick={() => void handleDownloadPython()}>
          Download Python
        </Button>
        <Button
          variant="primary"
          onClick={() => void handleRetry()}
          disabled={aiToolsStatus.installInProgress}
        >
          {isPythonMissing ? "Retry After Python Install" : "Retry Install"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

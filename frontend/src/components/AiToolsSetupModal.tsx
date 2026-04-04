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

function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return encodeURI(normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`);
}

function parentPath(path: string): string {
  const segments = path.split(/[/\\]+/);
  segments.pop();
  return segments.join("/");
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
  const hasInstallError = aiToolsStatus.state === "error" || aiToolsStatus.state === "cancelled";
  const requiresExternalPython = aiToolsStatus.requiresExternalPython;
  const isBundledFlow = aiToolsStatus.installSource === "bundledRuntime" && !requiresExternalPython;
  const isModelFailure = aiToolsStatus.errorCode === "model_download_failed";
  const isBundledRuntimeFailure =
    aiToolsStatus.errorCode === "runtime_seed_missing" ||
    aiToolsStatus.errorCode === "runtime_copy_failed" ||
    aiToolsStatus.errorCode === "runtime_verification_failed";
  const installLogPath = aiToolsStatus.detailLogPath;

  const errorTitle = isModelFailure
    ? "Model download needs attention"
    : isBundledRuntimeFailure
      ? "Built-in AI runtime setup failed"
      : aiToolsStatus.state === "cancelled"
        ? "AI tools setup was cancelled"
        : requiresExternalPython
          ? "AI tools setup needs Python help"
          : "AI tools setup needs attention";

  const recommendationText = isBundledFlow
    ? "This build already includes the AI runtime. OpenStudio should prepare it automatically in the background and then download the stem model."
    : "This build needs Python 3.10 or newer on your machine first. Once Python is installed, OpenStudio will continue the rest of the AI setup automatically.";

  const retryGuidance = isModelFailure
    ? "The runtime is already in place. Retry after checking your internet connection, VPN, firewall, or antivirus if the download keeps failing."
    : isBundledFlow
      ? "Retry from this window to let OpenStudio prepare the built-in AI runtime again. If the same error comes back, open the install log location for details."
      : aiToolsStatus.pythonDetected
        ? "Python was detected, so you can usually retry from this window. If the same error comes back, restart OpenStudio and reopen this setup window before trying again."
        : "OpenStudio could not confirm a usable Python installation yet. Install Python first, restart OpenStudio, then reopen this setup window and retry.";

  const handleDownloadPython = async () => {
    await nativeBridge.openExternalURL(PYTHON_DOWNLOAD_URL);
  };

  const handleOpenInstallLog = async () => {
    if (!installLogPath) return;
    await nativeBridge.openExternalURL(toFileUrl(parentPath(installLogPath)));
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
              clip into individual tracks like Vocals, Drums, Bass, Guitar, and more.
            </p>
          </div>

          <div className="rounded border border-neutral-800 bg-neutral-950/60 p-3 space-y-1">
            <p className="text-sm font-medium text-daw-text">
              {isBundledFlow ? "Built-in runtime setup" : "Python-based setup"}
            </p>
            <p className="text-xs text-daw-text-secondary leading-relaxed">{recommendationText}</p>
          </div>

          {isPythonMissing ? (
            <div className="rounded border border-yellow-600/40 bg-yellow-950/30 p-3 space-y-2">
              <p className="text-sm font-semibold text-yellow-400">Python is required</p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                OpenStudio could not find Python 3.10 or newer on this machine. Python is needed
                for this build before AI Tools can be installed.
              </p>
            </div>
          ) : hasInstallError ? (
            <div className="rounded border border-red-600/40 bg-red-950/30 p-3 space-y-2">
              <p className="text-sm font-semibold text-red-400">{errorTitle}</p>
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                {isModelFailure
                  ? "OpenStudio prepared the AI runtime, but the stem model download did not complete."
                  : isBundledRuntimeFailure
                    ? "OpenStudio could not prepare the built-in AI tools runtime on this machine."
                    : "OpenStudio could not finish the AI tools setup."}
              </p>
              {aiToolsStatus.error ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Error reported: <span className="text-daw-text">{aiToolsStatus.error}</span>
                </p>
              ) : null}
              <p className="text-xs text-daw-text-secondary leading-relaxed">
                Install source:{" "}
                <span className="text-daw-text">
                  {isBundledFlow ? "Built-in OpenStudio runtime" : "External Python bootstrap"}
                </span>
              </p>
              {requiresExternalPython ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed">
                  Python detected:{" "}
                  <span className={aiToolsStatus.pythonDetected ? "text-green-400" : "text-yellow-300"}>
                    {aiToolsStatus.pythonDetected ? "Yes" : "No"}
                  </span>
                </p>
              ) : null}
              {installLogPath ? (
                <p className="text-xs text-daw-text-secondary leading-relaxed break-all">
                  Install log: <span className="text-daw-text">{installLogPath}</span>
                </p>
              ) : null}
              <p className="text-xs text-daw-text-secondary leading-relaxed">{retryGuidance}</p>
            </div>
          ) : null}

          {requiresExternalPython ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-daw-text-secondary uppercase tracking-wide">
                Python setup steps
              </p>
              <div className="space-y-3 pt-1">
                {IS_WINDOWS ? (
                  <>
                    <Step number={1}>
                      Click <span className="text-daw-text font-medium">Download Python</span> below.
                      Your browser will open the official Python website. Download the latest{" "}
                      <span className="text-daw-text font-medium">Python 3.x</span> installer for{" "}
                      <span className="text-daw-text font-medium">Windows 64-bit</span>.
                    </Step>
                    <Step number={2}>
                      Open the downloaded installer. On the very first screen, turn on the checkbox
                      that says{" "}
                      <span className="text-yellow-400 font-semibold">
                        Add python.exe to PATH
                      </span>
                      . This simply allows OpenStudio to find Python automatically later.
                    </Step>
                    <Step number={3}>
                      Click the normal install option and wait for setup to finish. If Windows asks
                      for permission, choose <span className="text-daw-text font-medium">Yes</span>.
                    </Step>
                    <Step number={4}>
                      After installation, restart OpenStudio completely, then click{" "}
                      <span className="text-daw-text font-medium">Retry After Python Install</span>.
                    </Step>
                    <Step number={5}>
                      If OpenStudio still says Python is missing, rerun the installer and make sure
                      the <span className="text-yellow-400 font-semibold">Add to PATH</span> box was
                      enabled.
                    </Step>
                  </>
                ) : (
                  <>
                    <Step number={1}>
                      Click <span className="text-daw-text font-medium">Download Python</span> below.
                      This opens the official Python website. Download the latest{" "}
                      <span className="text-daw-text font-medium">Python 3.x</span> installer for
                      macOS.
                    </Step>
                    <Step number={2}>
                      Open the downloaded installer package and follow the normal steps. If macOS
                      asks for permission, allow it and continue.
                    </Step>
                    <Step number={3}>
                      Restart OpenStudio completely, then click{" "}
                      <span className="text-daw-text font-medium">Retry After Python Install</span>.
                    </Step>
                    <Step number={4}>
                      Advanced option: if you already use Homebrew, you can install Python from
                      Terminal with <CodeSnip>brew install python3</CodeSnip>, then restart
                      OpenStudio and retry from this window.
                    </Step>
                    <Step number={5}>
                      If OpenStudio still cannot find Python after installing it, restart your Mac
                      once and then reopen OpenStudio before retrying.
                    </Step>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-xs font-medium text-daw-text-secondary uppercase tracking-wide">
                Built-in setup steps
              </p>
              <div className="space-y-3 pt-1">
                <Step number={1}>
                  Click <span className="text-daw-text font-medium">Retry Install</span> below.
                  OpenStudio will copy its built-in AI runtime into your user profile in the
                  background.
                </Step>
                <Step number={2}>
                  Keep OpenStudio open while setup runs. The progress halo around the{" "}
                  <CodeSnip>AI</CodeSnip> toolbar button shows that work is still happening.
                </Step>
                <Step number={3}>
                  If the error mentions the model download, check your internet connection and retry.
                </Step>
                <Step number={4}>
                  If setup keeps failing, use <span className="text-daw-text font-medium">Open Install Log</span>{" "}
                  to inspect the detailed log location before retrying again.
                </Step>
              </div>
            </div>
          )}

          <div className="border-t border-neutral-800 pt-3 space-y-2">
            <p className="text-xs text-daw-text-secondary leading-relaxed">
              After the runtime is ready, OpenStudio will continue the rest of the AI tools setup in
              the background. You can keep using the app while that runs.
            </p>
          </div>
        </div>
      </ModalContent>
      <ModalFooter>
        <Button variant="ghost" onClick={closeAiToolsSetup}>
          Close
        </Button>
        {installLogPath ? (
          <Button variant="ghost" onClick={() => void handleOpenInstallLog()}>
            Open Install Log
          </Button>
        ) : null}
        {requiresExternalPython ? (
          <Button variant="secondary" onClick={() => void handleDownloadPython()}>
            Download Python
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={() => void handleRetry()}
          disabled={aiToolsStatus.installInProgress}
        >
          {requiresExternalPython && isPythonMissing ? "Retry After Python Install" : "Retry Install"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

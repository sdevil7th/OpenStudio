import { useEffect, useState, useSyncExternalStore } from "react";
import { getAppDialog, subscribeAppDialogs, finishAppDialog } from "../services/appDialogs";
import { nativeBridge } from "../services/NativeBridge";
import { Modal, Button, Input } from "./ui";
import licenseText from "../../../LICENSE?raw";
import nativeNotices from "../../../THIRD_PARTY_LICENSES.md?raw";
import frontendNotices from "../../THIRD_PARTY_NOTICES.txt?raw";

export function AppDialogHost() {
  const request = useSyncExternalStore(subscribeAppDialogs, getAppDialog, () => null);
  const [value, setValue] = useState("");
  const [detail, setDetail] = useState("");
  useEffect(() => { setValue(request?.initialValue ?? ""); setDetail(""); }, [request?.id]);
  if (!request) return null;
  const close = () => finishAppDialog(request.id, null);
  const accept = () => finishAppDialog(request.id, request.kind === "prompt" ? value : "ok");
  return (
    <Modal isOpen onClose={close} size="sm" title={request.kind === "about" ? "About OpenStudio" : request.kind === "confirm" ? "Confirm" : "OpenStudio"}
      footer={<>
        {(request.kind === "prompt" || request.kind === "confirm") && <Button onClick={close}>Cancel</Button>}
        <Button variant="primary" onClick={accept}>{request.kind === "about" ? "Close" : "OK"}</Button>
      </>}>
      {request.kind === "about" ? (
        <div className="space-y-3 text-sm text-neutral-300">
          <p className="text-lg font-semibold text-neutral-100">OpenStudio {request.message}</p>
          <p>Record, edit, mix, and create music.</p>
          <p>Free and open source under the GNU AGPL v3. Third-party components and content retain their own licenses.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void nativeBridge.openExternalURL("https://github.com/sdevil7th/OpenStudio")}>Project</Button>
            <Button onClick={() => void nativeBridge.openExternalURL("https://github.com/sdevil7th/OpenStudio/issues")}>Support</Button>
            <Button onClick={() => setDetail(licenseText)}>License</Button>
            <Button onClick={() => setDetail(nativeNotices + "\n\n" + frontendNotices)}>Third-party notices</Button>
            <Button onClick={() => {
              const id = request.id;
              void nativeBridge.getAudioDeviceSetup().then(audio => {
                if (getAppDialog()?.id === id) setDetail(JSON.stringify({ version: request.message, platform: navigator.platform, audio }, null, 2));
              }).catch(error => { if (getAppDialog()?.id === id) setDetail(String(error)); });
            }}>Device diagnostics</Button>
          </div>
          {detail && <textarea readOnly aria-label="About details" className="h-60 w-full resize-y rounded border border-neutral-600 bg-neutral-950 p-2 font-mono text-xs" value={detail} onFocus={event => event.currentTarget.select()} />}
        </div>
      ) : (
        <form className="space-y-3" onSubmit={event => { event.preventDefault(); accept(); }}>
          <p id={`app-dialog-${request.id}`} className="whitespace-pre-wrap break-words text-sm text-neutral-200">{request.message}</p>
          {request.kind === "prompt" && <Input key={request.id} autoFocus aria-labelledby={`app-dialog-${request.id}`} value={value}
            onChange={event => setValue(event.target.value)} onFocus={event => event.target.select()} />}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1}>OK</button>
        </form>
      )}
    </Modal>
  );
}

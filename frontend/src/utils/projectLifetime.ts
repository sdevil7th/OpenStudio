// Runtime identity, deliberately not persisted. Reopening the same project and
// track IDs must still invalidate work started in the previous document.
let epoch = 0;
let recoveryDocumentId = crypto.randomUUID().replace(/-/g, "");
export const getRecoveryDocumentId = () => recoveryDocumentId;
export const getProjectEpoch = () => epoch;
export const advanceProjectEpoch = () => {
  recoveryDocumentId = crypto.randomUUID().replace(/-/g, "");
  return ++epoch;
};
let editRevision = 0;
export const markProjectEdited = () => ++editRevision;
export const getProjectEditRevision = () => editRevision;

let saveTail: Promise<unknown> = Promise.resolve();
export function serializeProjectSave(save: () => Promise<boolean>): Promise<boolean> {
  const requestedEpoch = epoch;
  const result = saveTail.then(() => requestedEpoch === epoch ? save() : false);
  saveTail = result.catch(() => false);
  return result;
}

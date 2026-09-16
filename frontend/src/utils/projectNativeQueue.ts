import { getProjectEpoch } from "./projectLifetime";

/** Order native execute/undo/redo effects without blocking synchronous history.
 * The epoch guard prevents queued work from re-creating data in a new project.
 */
export function projectNativeQueue(epoch: number, report: (error: unknown) => void) {
  let tail = Promise.resolve();
  return (action: (current: () => boolean) => Promise<unknown>): Promise<void> => {
    const current = () => epoch === getProjectEpoch();
    const operation = tail.then(async () => { if (current()) await action(current); });
    tail = operation.catch(report);
    return operation;
  };
}

/**
 * 下载队列层
 * @author IsCibocaz
 * @since 1.11.0
 */
export {
    acquireLock,
    cancelTask,
    clearCancelRequest,
    clearFinished,
    CRASH_ERROR,
    emptyQueue,
    enqueue,
    lockHolderOf,
    patchTask,
    progressThrottle,
    PROGRESS_INTERVAL_MS,
    QUEUE_SCHEMA,
    readCancelRequests,
    readQueue,
    recoverRunning,
    requestCancel,
    retryTask,
    stamp,
    TaskCancelled,
    taskErrorOf,
    writeQueue,
    type CancelResult,
    type DownloadQueue,
    type DownloadTask,
    type EnqueueInput,
    type ModInstallParams,
    type QueueLock,
    type TaskError,
    type TaskPatch,
    type TaskProgress,
    type TaskState,
    type TaskType,
} from "./queue.ts";
export {
    workOffQueue,
    type TaskControl,
    type TaskResult,
    type WorkerOptions,
    type WorkerReport,
} from "./worker.ts";

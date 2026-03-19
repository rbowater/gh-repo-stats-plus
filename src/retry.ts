export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  successThreshold?: number; // Number of successful runs needed to reset retry count
}

export interface RetryState {
  attempt: number;
  successCount: number;
  retryCount: number;
  lastProcessedRepo?: string;
  error?: Error;
}

/**
 * A signal object that the operation can use to request a reset of the
 * internal attempt counter. When `requested` is set to `true` before the
 * operation throws, `withRetry` will reset its attempt counter back to 0,
 * giving the caller a fresh set of retries.
 */
export interface RetryResetSignal {
  requested: boolean;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig,
  onRetry?: (state: RetryState) => void,
  resetSignal?: RetryResetSignal,
): Promise<T> {
  let lastError: Error | undefined;
  let currentDelay = config.initialDelayMs;
  let retryCount = 0;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      if (resetSignal) {
        resetSignal.requested = false;
      }

      const result = await operation();
      return result;
    } catch (error) {
      // If the operation signalled a reset (enough consecutive successes
      // occurred before this failure), restart the attempt counter so the
      // caller gets a fresh set of retries.
      if (resetSignal?.requested) {
        attempt = 0; // becomes 1 after for-loop increment
        currentDelay = config.initialDelayMs;
        retryCount = 0;
        resetSignal.requested = false;
      }

      retryCount++;

      lastError =
        error instanceof Error
          ? error
          : new Error(
              typeof error === 'object' ? JSON.stringify(error) : String(error),
            );

      if (attempt === config.maxAttempts) {
        break;
      }

      if (onRetry) {
        onRetry({
          attempt,
          error: lastError,
          successCount: 0,
          retryCount,
        });
      }

      await sleep(currentDelay);
      currentDelay = Math.min(
        currentDelay * config.backoffFactor,
        config.maxDelayMs,
      );
    }
  }

  throw new Error(
    `Operation failed after ${config.maxAttempts} attempts: ${
      lastError?.message || 'No error message available'
    }${lastError?.stack ? `\nStack trace: ${lastError.stack}` : ''}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

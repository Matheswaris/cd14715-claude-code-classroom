
/**
 * Configuration for the rate limiter.
 */
export interface RateLimiterConfig {
  maxRequestsPerMinute: number;
  maxTokensPerMinute: number;
  maxConcurrent: number;
}

/**
 * Information about a request handled by the rate limiter.
 */
interface RequestRecord {
  timestamp: number;
  tokens: number;
}

/**
 * Default rate limits.
 */
const DEFAULT_RATE_LIMITS: RateLimiterConfig = {
  maxRequestsPerMinute: 50,
  maxTokensPerMinute: 100000,
  maxConcurrent: 5
};

/**
 * Rate limiter for API requests.
 */
export class RateLimiter {
  private config: RateLimiterConfig;
  private requestHistory: RequestRecord[] = [];
  private activeRequests: number = 0;
  private waitQueue: Array<() => void> = [];

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = {
      ...DEFAULT_RATE_LIMITS,
      ...config
    };
  }

  /**
   * Acquire permission to make a request.
   */
  async acquire(estimatedTokens: number = 0): Promise<void> {
    while (!this.canProceed(estimatedTokens)) {
      if (this.activeRequests >= this.config.maxConcurrent) {
        await this.waitForSlot();
      } else {
        await this.waitForRateLimit(estimatedTokens);
      }
    }

    this.activeRequests++;

    this.requestHistory.push({
      timestamp: Date.now(),
      tokens: estimatedTokens
    });
  }

  /**
   * Release an active request.
   */
  release(actualTokens?: number): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);

    if (actualTokens !== undefined && this.requestHistory.length > 0) {
      const lastRequest =
        this.requestHistory[this.requestHistory.length - 1];

      if (lastRequest) {
        lastRequest.tokens = actualTokens;
      }
    }

    const next = this.waitQueue.shift();

    if (next) {
      next();
    }
  }

  /**
   * Return current rate-limit information.
   */
  getStats(): {
    activeRequests: number;
    requestsInLastMinute: number;
    tokensInLastMinute: number;
  } {
    this.pruneOldRecords();

    return {
      activeRequests: this.activeRequests,
      requestsInLastMinute: this.requestHistory.length,
      tokensInLastMinute: this.requestHistory.reduce(
        (total, request) => total + request.tokens,
        0
      )
    };
  }

  /**
   * Check whether another request can proceed.
   */
  private canProceed(estimatedTokens: number): boolean {
    this.pruneOldRecords();

    if (this.activeRequests >= this.config.maxConcurrent) {
      return false;
    }

    const requestsInWindow = this.requestHistory.length;

    if (requestsInWindow >= this.config.maxRequestsPerMinute) {
      return false;
    }

    const tokensInWindow = this.requestHistory.reduce(
      (total, request) => total + request.tokens,
      0
    );

    if (
      tokensInWindow + estimatedTokens >
      this.config.maxTokensPerMinute
    ) {
      return false;
    }

    return true;
  }

  /**
   * Wait until a concurrent request slot becomes available.
   */
  private async waitForSlot(): Promise<void> {
    if (this.activeRequests < this.config.maxConcurrent) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  /**
   * Wait until the per-minute rate limit allows another request.
   */
  private async waitForRateLimit(estimatedTokens: number): Promise<void> {
    while (true) {
      this.pruneOldRecords();

      if (this.canProceed(estimatedTokens)) {
        return;
      }

      if (this.requestHistory.length === 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });

        continue;
      }

      const oldestRequest = this.requestHistory[0];

      if (!oldestRequest) {
        return;
      }

      const elapsed = Date.now() - oldestRequest.timestamp;
      const waitTime = Math.max(60000 - elapsed, 1);

      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitTime);
      });
    }
  }

  /**
   * Remove request records older than one minute.
   */
  private pruneOldRecords(): void {
    const cutoff = Date.now() - 60000;

    this.requestHistory = this.requestHistory.filter(
      (request) => request.timestamp > cutoff
    );
  }
}

/**
 * Global rate limiter instance.
 */
export const globalRateLimiter = new RateLimiter();

/**
 * Execute a function while respecting the global rate limiter.
 */
export async function withRateLimit<T>(
  fn: () => Promise<T>,
  estimatedTokens: number = 0
): Promise<T> {
  await globalRateLimiter.acquire(estimatedTokens);

  try {
    const result = await fn();
    return result;
  } finally {
    globalRateLimiter.release();
  }
}
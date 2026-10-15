import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewReportSchema } from '../src/types/report-types.js';
import {
  ErrorCodes,
  ReviewError,
  withRetry,
  withTimeout
} from '../src/utils/error-handler.js';
import { RateLimiter } from '../src/utils/rate-limiter.js';
import { CodeReviewOrchestrator } from '../src/orchestrator.js';

const validReport = {
  pullRequest: {
    owner: 'udacity',
    repo: 'cd14715-simple-todo-app',
    number: 1
  },
  fileReviews: [
    {
      file: 'src/todo.ts',
      codeQuality: {
        file: 'src/todo.ts',
        issues: [],
        overallScore: 90,
        summary: 'Good quality'
      },
      testCoverage: {
        file: 'src/todo.ts',
        hasTests: true,
        testFiles: ['tests/todo.test.ts'],
        untestedPaths: [],
        coverageEstimate: 85,
        summary: 'Good coverage'
      },
      refactorings: {
        file: 'src/todo.ts',
        suggestions: [],
        summary: 'No major refactoring required'
      }
    }
  ],
  summary: {
    totalFiles: 1,
    overallScore: 90,
    criticalIssues: 0,
    highPriorityTests: 0,
    refactoringOpportunities: 0
  },
  recommendations: [
    {
      priority: 'low' as const,
      category: 'maintainability',
      description: 'Maintain test coverage',
      files: ['src/todo.ts']
    }
  ],
  metadata: {
    analyzedAt: new Date().toISOString(),
    duration: 1000,
    agentVersions: {
      codeQuality: '1.0'
    }
  }
};

describe('ReviewReportSchema', () => {
  it('accepts a valid report', () => {
    const result = ReviewReportSchema.safeParse(validReport);

    expect(result.success).toBe(true);
  });

  it('rejects an invalid report', () => {
    const invalidReport = {
      ...validReport,
      pullRequest: {
        ...validReport.pullRequest,
        number: 'invalid'
      }
    };

    const result = ReviewReportSchema.safeParse(invalidReport);

    expect(result.success).toBe(false);
  });

  it('rejects a score greater than 100', () => {
    const invalidReport = structuredClone(validReport);

    invalidReport.fileReviews[0].codeQuality.overallScore = 101;

    const result = ReviewReportSchema.safeParse(invalidReport);

    expect(result.success).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns successful result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const result = await withRetry(fn, 3, 0);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries after failure and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue('success');

    const result = await withRetry(fn, 3, 0);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws RETRY_EXHAUSTED when all attempts fail', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('failure'));

    try {
      await withRetry(fn, 2, 0);

      throw new Error('withRetry should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewError);
      expect((error as ReviewError).code).toBe(
        ErrorCodes.RETRY_EXHAUSTED
      );
    }

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns when operation completes before timeout', async () => {
    const result = await withTimeout(
      async () => 'completed',
      1000
    );

    expect(result).toBe('completed');
  });

  it('throws AGENT_TIMEOUT when timeout is reached', async () => {
    vi.useFakeTimers();

    const promise = withTimeout(
      () => new Promise<string>(() => {}),
      1000,
      'Agent timed out'
    );

    const assertion = expect(promise).rejects.toMatchObject({
      code: ErrorCodes.AGENT_TIMEOUT,
      message: 'Agent timed out'
    });

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe('RateLimiter', () => {
  it('tracks requests and tokens', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 10,
      maxTokensPerMinute: 1000,
      maxConcurrent: 2
    });

    await limiter.acquire(100);

    const stats = limiter.getStats();

    expect(stats.activeRequests).toBe(1);
    expect(stats.requestsInLastMinute).toBe(1);
    expect(stats.tokensInLastMinute).toBe(100);

    limiter.release();

    expect(limiter.getStats().activeRequests).toBe(0);
  });

  it('updates actual token usage on release', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 10,
      maxTokensPerMinute: 1000,
      maxConcurrent: 2
    });

    await limiter.acquire(100);
    limiter.release(75);

    expect(limiter.getStats().tokensInLastMinute).toBe(75);
    expect(limiter.getStats().activeRequests).toBe(0);
  });

  it('enforces the concurrency limit', async () => {
    const limiter = new RateLimiter({
      maxRequestsPerMinute: 10,
      maxTokensPerMinute: 1000,
      maxConcurrent: 1
    });

    await limiter.acquire(10);

    let secondAcquired = false;

    const secondRequest = limiter.acquire(10).then(() => {
      secondAcquired = true;
    });

    await Promise.resolve();

    expect(secondAcquired).toBe(false);
    expect(limiter.getStats().activeRequests).toBe(1);

    limiter.release();

    await secondRequest;

    expect(secondAcquired).toBe(true);
    expect(limiter.getStats().activeRequests).toBe(1);

    limiter.release();

    expect(limiter.getStats().activeRequests).toBe(0);
  });
});

describe('Integration', () => {
  it(
    'reviews udacity/cd14715-simple-todo-app PR 1',
    async () => {
      const orchestrator = new CodeReviewOrchestrator({
        timeoutMs: 600000
      });

      const report = await orchestrator.reviewPullRequest(
        'udacity',
        'cd14715-simple-todo-app',
        1
      );

      expect(report).toBeDefined();
      expect(report.pullRequest.owner).toBe('udacity');
      expect(report.pullRequest.repo).toBe(
        'cd14715-simple-todo-app'
      );
      expect(report.pullRequest.number).toBe(1);
      expect(report.fileReviews.length).toBeGreaterThan(0);

      const validation = ReviewReportSchema.safeParse(report);

      expect(validation.success).toBe(true);
    },
    600000
  );
});
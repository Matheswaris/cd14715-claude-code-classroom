import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  ReviewReport,
  ReviewReportSchema,
  ReviewReportJSONSchema
} from './types/report-types.js';

import { mcpServersConfig } from './config/mcp.config.js';

import {
  codeQualityAnalyzer,
  testCoverageAnalyzer,
  refactoringSuggester
} from './agents/index.js';

import { orchestratorPrompt } from './prompts/index.js';

import { withRateLimit } from './utils/rate-limiter.js';
import { withTimeout } from './utils/error-handler.js';

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  timeoutMs?: number;
  estimatedTokens?: number;
}

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate
 * comprehensive reports.
 */
export class CodeReviewOrchestrator {
  private readonly timeoutMs: number;
  private readonly estimatedTokens: number;

  constructor(options: OrchestratorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.estimatedTokens = options.estimatedTokens ?? 10000;
  }

  /**
   * Review a pull request using parallel subagent analysis.
   *
   * @param owner Repository owner
   * @param repo Repository name
   * @param prNumber Pull request number
   * @returns Complete validated review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    const prompt = `
${orchestratorPrompt}

Review the following GitHub pull request:

Repository owner: ${owner}
Repository name: ${repo}
Pull request number: ${prNumber}

Use the GitHub MCP server to retrieve the pull request and changed files.

Use all three specialized subagents:
1. code-quality-analyzer
2. test-coverage-analyzer
3. refactoring-suggester

Analyze the changed files and aggregate all findings into one final
ReviewReport.

Return only the structured output required by ReviewReportSchema.
`;

    const runReview = async (): Promise<ReviewReport> => {
      const sdkQuery = query({
        prompt,
        options: {
          model: process.env.ANTHROPIC_MODEL,

          mcpServers: mcpServersConfig,

          agents: {
            'code-quality-analyzer': codeQualityAnalyzer,
            'test-coverage-analyzer': testCoverageAnalyzer,
            'refactoring-suggester': refactoringSuggester
          },

          allowedTools: [
            'Task',
            'Read',
            'Grep',
            'Glob',
            'Skill',
            'mcp__github__*',
            'mcp__eslint__*'
          ],

          outputFormat: {
            type: 'json_schema',
            schema: ReviewReportJSONSchema
          },

          permissionMode: 'bypassPermissions'
        }
      });

      let structuredOutput: unknown;

      for await (const message of sdkQuery) {
        if (
          message.type === 'result' &&
          message.subtype === 'success'
        ) {
          structuredOutput = message.structured_output;
        }
      }

      if (structuredOutput === undefined) {
        throw new Error(
          'Claude Agent SDK did not return structured review output'
        );
      }

      return ReviewReportSchema.parse(structuredOutput);
    };

    return withRateLimit(
      () =>
        withTimeout(
          runReview,
          this.timeoutMs,
          `Pull request review timed out for ${owner}/${repo}#${prNumber}`
        ),
      this.estimatedTokens
    );
  }
}
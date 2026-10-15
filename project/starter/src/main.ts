import * as dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CodeReviewOrchestrator } from './orchestrator.js';
import { ReportGenerator } from './utils/report-generator.js';

dotenv.config();

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 *
 * Usage:
 * npm run dev -- <owner> <repo> <pr-number>
 */
async function main(): Promise<void> {
  const [owner, repo, prStr] = process.argv.slice(2);

  // Validate command-line arguments
  if (!owner || !repo || !prStr) {
    console.error(
      'Usage: npm run dev -- <owner> <repo> <pr-number>'
    );
    process.exitCode = 1;
    return;
  }

  const prNumber = Number(prStr);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(
      `Invalid pull request number: ${prStr}`
    );
    process.exitCode = 1;
    return;
  }

  // Validate authentication
  const hasAnthropicAuth = Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN
  );

  const hasAwsAuth = Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
  );

  if (hasAwsAuth) {
    if (!process.env.AWS_REGION) {
      console.error(
        'AWS_REGION is required when using AWS Bedrock authentication.'
      );
      process.exitCode = 1;
      return;
    }

    console.log('Using AWS Bedrock authentication');
  } else if (hasAnthropicAuth) {
    console.log('Using Anthropic API authentication');
  } else {
    console.error(
      'Authentication is not configured. Set Anthropic credentials or AWS Bedrock credentials.'
    );
    process.exitCode = 1;
    return;
  }

  // Validate model configuration
  if (!process.env.ANTHROPIC_MODEL) {
    console.error(
      'ANTHROPIC_MODEL environment variable is required.'
    );
    process.exitCode = 1;
    return;
  }

  try {
    console.log(
      `Reviewing pull request ${owner}/${repo}#${prNumber}...`
    );

const orchestrator = new CodeReviewOrchestrator({
  timeoutMs: 600000
});

    const report = await orchestrator.reviewPullRequest(
      owner,
      repo,
      prNumber
    );

    const reportGenerator = new ReportGenerator();

    const markdown =
      reportGenerator.generateMarkdownReport(report);

    const html =
      reportGenerator.generateHTMLReport(report);

    const json =
      reportGenerator.generateJSONReport(report);

    const reportsDirectory = join(
      process.cwd(),
      'reports'
    );

    await mkdir(reportsDirectory, {
      recursive: true
    });

    const baseFilename =
      `${owner}-${repo}-pr-${prNumber}`;

    await Promise.all([
      writeFile(
        join(
          reportsDirectory,
          `${baseFilename}.md`
        ),
        markdown,
        'utf8'
      ),

      writeFile(
        join(
          reportsDirectory,
          `${baseFilename}.html`
        ),
        html,
        'utf8'
      ),

      writeFile(
        join(
          reportsDirectory,
          `${baseFilename}.json`
        ),
        json,
        'utf8'
      )
    ]);

    console.log('Review completed successfully.');
    console.log(
      `Reports saved to: ${reportsDirectory}`
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error('Error:', message);
    process.exitCode = 1;
  }
}

main();
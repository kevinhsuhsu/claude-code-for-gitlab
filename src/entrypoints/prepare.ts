#!/usr/bin/env bun

/**
 * Prepare the Claude action by checking trigger conditions, verifying human actor,
 * and creating the initial tracking comment
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { checkHumanActor } from "../github/validation/actor";
import { checkWritePermissions } from "../github/validation/permissions";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { setupBranch } from "../github/operations/branch";
import { configureGitAuth } from "../github/operations/git-config";
import { prepareMcpConfig } from "../mcp/install-mcp-server";
import { createOctokit } from "../github/api/client";
import { fetchGitHubData } from "../github/data/fetcher";
import { parseGitHubContext } from "../github/context";
import { getMode } from "../modes/registry";
import { createPrompt } from "../create-prompt";
import {
  createProvider,
  getToken,
  detectPlatform,
} from "../providers/provider-factory";
import type { SCMProvider } from "../providers/scm-provider";
import { getClaudePromptsDirectory } from "../utils/temp-directory";
import { parseGitLabWebhookPayload } from "../gitlab/webhook";

async function run() {
  const platform = detectPlatform();

  // Debug environment variables related to authentication
  if (platform === "gitlab") {
    console.log("=== GitLab Environment Variables Debug ===");
    const authVars = [
      "CLAUDE_CODE_GL_ACCESS_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITLAB_TOKEN",
      "CI_JOB_TOKEN",
    ];

    authVars.forEach((varName) => {
      const value = process.env[varName];
      if (value) {
        if (value.startsWith("$")) {
          console.log(
            `${varName}: UNEXPANDED ("${value}") - Variable not set in CI/CD settings!`,
          );
        } else {
          console.log(
            `${varName}: Set (length: ${value.length}, prefix: "${value.substring(0, 8)}...")`,
          );
        }
      } else {
        console.log(`${varName}: Not set`);
      }
    });
    console.log("=========================================");
  }

  // Use platform-specific logic
  if (platform === "gitlab") {
    // GitLab mode - output platform using echo
    console.log(`platform=${platform}`);
    await runGitLab();
  } else {
    // GitHub mode - use core.setOutput
    core.setOutput("platform", platform);
    await runGitHub();
  }
}

async function runGitHub() {
  try {
    // Step 1: Setup GitHub token
    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);

    // Step 2: Parse GitHub context (once for all operations)
    const context = parseGitHubContext();

    // Step 3: Check write permissions
    const hasWritePermissions = await checkWritePermissions(
      octokit.rest,
      context,
    );
    if (!hasWritePermissions) {
      throw new Error(
        "Actor does not have write permissions to the repository",
      );
    }

    // Step 4: Get mode and check trigger conditions
    const mode = getMode(context.inputs.mode);
    const containsTrigger = mode.shouldTrigger(context);

    // Set output for action.yml to check
    core.setOutput("contains_trigger", containsTrigger.toString());

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      return;
    }

    // Step 5: Check if actor is human
    await checkHumanActor(octokit.rest, context);

    // Step 6: Create initial tracking comment (mode-aware)
    // Some modes (e.g., future review/freeform modes) may not need tracking comments
    let commentId: number | undefined;
    let commentData:
      | Awaited<ReturnType<typeof createInitialComment>>
      | undefined;
    if (mode.shouldCreateTrackingComment()) {
      commentData = await createInitialComment(octokit.rest, context);
      commentId = commentData.id;
    }

    // Step 7: Fetch GitHub data (once for both branch setup and prompt creation)
    const githubData = await fetchGitHubData({
      octokits: octokit,
      repository: `${context.repository.owner}/${context.repository.repo}`,
      prNumber: context.entityNumber.toString(),
      isPR: context.isPR,
      triggerUsername: context.actor,
    });

    // Step 8: Setup branch
    const branchInfo = await setupBranch(octokit, githubData, context);

    // Step 9: Configure git authentication if not using commit signing
    if (!context.inputs.useCommitSigning) {
      try {
        await configureGitAuth(githubToken, context, commentData?.user || null);
      } catch (error) {
        console.error("Failed to configure git authentication:", error);
        throw error;
      }
    }

    // Step 10: Create prompt file
    const modeContext = mode.prepareContext(context, {
      commentId,
      baseBranch: branchInfo.baseBranch,
      claudeBranch: branchInfo.claudeBranch,
    });

    await createPrompt(mode, modeContext, githubData, context);

    // Step 11: Get MCP configuration
    const additionalMcpConfig = process.env.MCP_CONFIG || "";
    const mcpConfig = await prepareMcpConfig({
      githubToken,
      owner: context.repository.owner,
      repo: context.repository.repo,
      branch: branchInfo.claudeBranch || branchInfo.currentBranch,
      baseBranch: branchInfo.baseBranch,
      additionalMcpConfig,
      claudeCommentId: commentId?.toString() || "",
      allowedTools: context.inputs.allowedTools,
      context,
    });
    core.setOutput("mcp_config", mcpConfig);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Prepare step failed with error: ${errorMessage}`);

    // Also output the clean error message for the action to capture
    core.setOutput("prepare_error", errorMessage);

    process.exit(1);
  }
}

async function runGitLab() {
  let provider: SCMProvider | null = null;

  try {
    console.log("Running in GitLab mode");

    // Step 1: Get appropriate token
    const token = getToken();

    // Step 2: Get trigger configuration
    // In GitLab CI, we only use environment variables
    const triggerPhrase = process.env.TRIGGER_PHRASE || "@claude";
    const directPrompt = process.env.DIRECT_PROMPT || "";

    // Step 3: Create provider instance
    provider = createProvider({
      platform: "gitlab",
      token,
      triggerPhrase,
      directPrompt,
    });

    // Step 4: Check write permissions
    console.log("Step 4: Checking write permissions...");
    const context = provider.getContext();
    console.log(`Checking permissions for actor: ${context.actor}`);

    let hasWritePermissions: boolean;
    try {
      hasWritePermissions = await provider.hasWritePermission(context.actor);
      console.log(`Write permissions check result: ${hasWritePermissions}`);
    } catch (error) {
      console.error("Error checking write permissions:", error);
      throw new Error(
        `Failed to check write permissions: ${error instanceof Error ? error.message : error}`,
      );
    }

    if (!hasWritePermissions) {
      throw new Error(
        "Actor does not have write permissions to the repository",
      );
    }

    // Step 5: Check trigger conditions
    console.log("Step 5: Checking trigger conditions...");
    let containsTrigger: boolean;
    try {
      containsTrigger = await provider.checkTrigger(
        triggerPhrase,
        directPrompt,
      );
      console.log(`Trigger check result: ${containsTrigger}`);
    } catch (error) {
      console.error("Error checking trigger:", error);
      throw new Error(
        `Failed to check trigger: ${error instanceof Error ? error.message : error}`,
      );
    }

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      return;
    }

    // Step 6: Check if actor is human (skip for direct prompts)
    if (!directPrompt) {
      console.log("Step 6: Checking if actor is human...");
      let isHuman: boolean;
      try {
        isHuman = await provider.isHumanActor(context.actor);
        console.log(`Human actor check result: ${isHuman}`);
      } catch (error) {
        console.error("Error checking human actor:", error);
        throw new Error(
          `Failed to check human actor: ${error instanceof Error ? error.message : error}`,
        );
      }
      if (!isHuman) {
        throw new Error("Actor is not a human user");
      }
    } else {
      console.log(
        "Step 6: Skipping human actor check (direct prompt provided)",
      );
    }

    // Step 7: Create initial tracking comment
    console.log("Step 7: Creating initial tracking comment...");
    const jobUrl = provider.getJobUrl();
    const commentBody = `🤖 Claude is working on this...

[View job details](${jobUrl})

---
- [ ] Setting up workspace
- [ ] Analyzing request  
- [ ] Implementing changes
- [ ] Running tests`;

    let commentId: number;
    try {
      commentId = await provider.createComment(commentBody);
      console.log(`Created comment with ID: ${commentId}`);
    } catch (error) {
      console.error("Error creating comment:", error);
      throw new Error(
        `Failed to create comment: ${error instanceof Error ? error.message : error}`,
      );
    }

    // Output comment ID for later use
    if (process.env.GITHUB_OUTPUT) {
      const fs = await import("fs");
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `claude_comment_id=${commentId}\n`,
      );
    }

    // Also set as environment variable for GitLab
    process.env.CLAUDE_COMMENT_ID = commentId.toString();

    // For GitLab, write to a file that can be read by the parent process
    const fileSystem = await import("fs");
    fileSystem.writeFileSync(
      "/tmp/claude-comment-id.txt",
      commentId.toString(),
    );

    // Step 8: GitLab-specific setup
    console.log("Step 8: GitLab-specific setup - creating prompt for Claude");

    // Configure git for GitLab
    console.log("Step 8a: Configuring git authentication...");
    try {
      await provider.setupGitAuth(token);
      console.log("Git authentication configured successfully");
    } catch (error) {
      console.error("Error configuring git auth:", error);
      throw new Error(
        `Failed to configure git auth: ${error instanceof Error ? error.message : error}`,
      );
    }

    // Fetch context data
    console.log("Step 8b: Fetching context data...");
    let contextData: any;
    try {
      contextData = await provider.fetchContextData();
      console.log("Context data fetched successfully");
      console.log("Context data type:", {
        hasIid: !!contextData.iid,
        hasTitle: !!contextData.title,
        hasProjectId: !!contextData.projectId,
        contextKeys: Object.keys(contextData),
      });
    } catch (error) {
      console.error("Error fetching context data:", error);
      throw new Error(
        `Failed to fetch context data: ${error instanceof Error ? error.message : error}`,
      );
    }

    // Create prompt directory
    const promptDir = getClaudePromptsDirectory();
    console.log(`Prompt dir: ${promptDir}`);

    // Extract trigger comment from webhook payload
    let triggerComment = "";
    const webhookPayload = parseGitLabWebhookPayload();
    if (webhookPayload?.object_kind === "note") {
      triggerComment = webhookPayload.object_attributes?.note || "";
      console.log("Found trigger comment from webhook:", triggerComment);
    } else if (webhookPayload?.object_kind === "issue") {
      // For issue events, the trigger might be in the description
      const issue = webhookPayload.issue || webhookPayload.object_attributes;
      if (issue?.description) {
        triggerComment = issue.description;
        console.log("Found trigger in issue description:", triggerComment);
      }
    } else if (webhookPayload?.object_kind === "merge_request") {
      // For MR events, check description
      const mr =
        webhookPayload.merge_request || webhookPayload.object_attributes;
      if (mr?.description) {
        triggerComment = mr.description;
        console.log("Found trigger in MR description:", triggerComment);
      }
    }

    // Generate prompt based on context
    let prompt = "";

    if (context.isPR && contextData.iid) {
      // Merge request context
      prompt = `You are Claude, an AI assistant helping with GitLab merge requests.

## Merge Request Context

**Title:** ${contextData.title}
**Description:** ${contextData.description || "No description provided"}
**Source Branch:** ${contextData.sourceBranch} → **Target Branch:** ${contextData.targetBranch}
**State:** ${contextData.state}
**Author:** ${contextData.author.name} (@${contextData.author.username})
**Web URL:** ${contextData.webUrl}

## Code Changes

${
  contextData.changes
    ?.map(
      (change: any) => `
### ${change.new_file ? "📄 New File" : change.deleted_file ? "🗑️ Deleted File" : change.renamed_file ? "📝 Renamed File" : "✏️ Modified File"}: \`${change.new_path}\`

\`\`\`diff
${change.diff}
\`\`\`
`,
    )
    .join("\n") || "No changes available"
}

## Existing Comments/Discussions

${
  contextData.discussions?.length > 0
    ? contextData.discussions
        .map((discussion: any) =>
          discussion.notes
            .map(
              (note: any) => `
**${note.author.name}** (${note.created_at}):
${note.body}
`,
            )
            .join("\n"),
        )
        .join("\n---\n")
    : "No existing comments"
}

## Your Task

${triggerComment ? `The user mentioned you with: "${triggerComment}"` : ""}

${directPrompt || "Please analyze this merge request and provide feedback on code quality, potential issues, and suggestions for improvement."}

When providing feedback, be specific and reference exact line numbers and file paths.`;
    } else if (contextData.iid && contextData.state) {
      // Issue context
      prompt = `You are Claude, an AI assistant helping with GitLab issues.

## Issue Context

**Title:** ${contextData.title}
**Description:** ${contextData.description || "No description provided"}
**State:** ${contextData.state}
**Author:** ${contextData.author.name} (@${contextData.author.username})
**Web URL:** ${contextData.webUrl}
**Labels:** ${contextData.labels?.join(", ") || "None"}

## Existing Comments/Discussions

${
  contextData.discussions?.length > 0
    ? contextData.discussions
        .map((discussion: any) =>
          discussion.notes
            .map(
              (note: any) => `
**${note.author.name}** (${note.created_at}):
${note.body}
`,
            )
            .join("\n"),
        )
        .join("\n---\n")
    : "No existing comments"
}

## Your Task

${triggerComment ? `The user mentioned you with: "${triggerComment}"` : ""}

${directPrompt || "Please analyze this issue and help with the requested task."}

When providing assistance, be specific and reference the issue context.`;
    } else {
      // Manual trigger or webhook without specific context
      prompt = `You are Claude, an AI assistant helping with GitLab projects.

## Project Context

**Project ID:** ${contextData.projectId || "Unknown"}
**Host:** ${contextData.host || "Unknown"}
**User:** ${contextData.userName || "Unknown"}

## Your Task

${triggerComment ? `The user mentioned you with: "${triggerComment}"` : ""}

${directPrompt || "Please help with the requested task."}`;
    }

    // Write prompt file
    console.log("Start writing into prompt dir...");
    const fs = await import("fs");
    await fs.promises.writeFile(`${promptDir}/claude-prompt.txt`, prompt);
    console.log("✅ Created prompt file for Claude");
    console.log(`Prompt file size: ${prompt.length} bytes`);
    console.log("Prompt preview (first 500 chars):");
    console.log(prompt.substring(0, 500));
    if (prompt.length > 500) {
      console.log("... (truncated)");
    }

    // GitLab doesn't need MCP config for now
    console.log("mcp_config=");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Prepare step failed with error: ${errorMessage}`);

    // Output error for GitLab CI
    console.log(`prepare_error=${errorMessage}`);

    // Try to update comment with error if we have a provider and comment ID
    if (provider && process.env.CLAUDE_COMMENT_ID) {
      try {
        await provider.updateComment(
          parseInt(process.env.CLAUDE_COMMENT_ID),
          `❌ Failed to prepare: ${errorMessage}`,
        );
      } catch (updateError) {
        console.error("Failed to update comment with error:", updateError);
      }
    }

    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}

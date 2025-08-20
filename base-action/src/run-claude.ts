import * as core from "@actions/core";
import { exec } from "child_process";
import { promisify } from "util";
import { unlink, writeFile, stat } from "fs/promises";
import { createWriteStream } from "fs";
import { spawn } from "child_process";

const execAsync = promisify(exec);

// Use platform-agnostic temp directory
const TEMP_DIR = process.env.RUNNER_TEMP || process.env.CI_BUILDS_DIR || "/tmp";
const PIPE_PATH = `${TEMP_DIR}/claude_prompt_pipe`;
const EXECUTION_FILE = `${TEMP_DIR}/claude-execution-output.json`;
const BASE_ARGS = ["-p", "--verbose", "--output-format", "stream-json"];

export type ClaudeOptions = {
  allowedTools?: string;
  disallowedTools?: string;
  maxTurns?: string;
  mcpConfig?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  claudeEnv?: string;
  fallbackModel?: string;
  timeoutMinutes?: string;
  model?: string;
};

type PreparedConfig = {
  claudeArgs: string[];
  promptPath: string;
  env: Record<string, string>;
};

function parseCustomEnvVars(claudeEnv?: string): Record<string, string> {
  if (!claudeEnv || claudeEnv.trim() === "") {
    return {};
  }

  const customEnv: Record<string, string> = {};

  // Split by lines and parse each line as KEY: VALUE
  const lines = claudeEnv.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#")) {
      continue; // Skip empty lines and comments
    }

    const colonIndex = trimmedLine.indexOf(":");
    if (colonIndex === -1) {
      continue; // Skip lines without colons
    }

    const key = trimmedLine.substring(0, colonIndex).trim();
    const value = trimmedLine.substring(colonIndex + 1).trim();

    if (key) {
      customEnv[key] = value;
    }
  }

  return customEnv;
}

export function prepareRunConfig(
  promptPath: string,
  options: ClaudeOptions,
): PreparedConfig {
  const claudeArgs = [...BASE_ARGS];

  if (options.allowedTools) {
    claudeArgs.push("--allowedTools", options.allowedTools);
  }
  if (options.disallowedTools) {
    claudeArgs.push("--disallowedTools", options.disallowedTools);
  }
  if (options.maxTurns) {
    const maxTurnsNum = parseInt(options.maxTurns, 10);
    if (isNaN(maxTurnsNum) || maxTurnsNum <= 0) {
      throw new Error(
        `maxTurns must be a positive number, got: ${options.maxTurns}`,
      );
    }
    claudeArgs.push("--max-turns", options.maxTurns);
  }
  if (options.mcpConfig) {
    claudeArgs.push("--mcp-config", options.mcpConfig);
  }
  if (options.systemPrompt) {
    claudeArgs.push("--system-prompt", options.systemPrompt);
  }
  if (options.appendSystemPrompt) {
    claudeArgs.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.fallbackModel) {
    claudeArgs.push("--fallback-model", options.fallbackModel);
  }
  if (options.model) {
    claudeArgs.push("--model", options.model);
  }
  if (options.timeoutMinutes) {
    const timeoutMinutesNum = parseInt(options.timeoutMinutes, 10);
    if (isNaN(timeoutMinutesNum) || timeoutMinutesNum <= 0) {
      throw new Error(
        `timeoutMinutes must be a positive number, got: ${options.timeoutMinutes}`,
      );
    }
  }

  // Parse custom environment variables
  const customEnv = parseCustomEnvVars(options.claudeEnv);

  return {
    claudeArgs,
    promptPath,
    env: customEnv,
  };
}

export async function runClaude(promptPath: string, options: ClaudeOptions) {
  const config = prepareRunConfig(promptPath, options);

  // Create a named pipe
  try {
    await unlink(PIPE_PATH);
  } catch (e) {
    // Ignore if file doesn't exist
  }

  // Create the named pipe
  await execAsync(`mkfifo "${PIPE_PATH}"`);

  // Log prompt file size
  let promptSize = "unknown";
  try {
    const stats = await stat(config.promptPath);
    promptSize = stats.size.toString();
  } catch (e) {
    // Ignore error
  }

  console.log(`Prompt file size: ${promptSize} bytes`);

  // Log custom environment variables if any
  if (Object.keys(config.env).length > 0) {
    const envKeys = Object.keys(config.env).join(", ");
    console.log(`Custom environment variables: ${envKeys}`);
  }

  // Check authentication before proceeding
  const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY || config.env.ANTHROPIC_API_KEY);
  const hasOAuthToken = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || config.env.CLAUDE_CODE_OAUTH_TOKEN);
  
  console.log("=== Authentication Status ===");
  console.log(`ANTHROPIC_API_KEY: ${hasAnthropicKey ? 'SET' : 'NOT SET'}`);
  console.log(`CLAUDE_CODE_OAUTH_TOKEN: ${hasOAuthToken ? 'SET' : 'NOT SET'}`);
  
  if (!hasAnthropicKey && !hasOAuthToken) {
    const errorMsg = `
❌ Authentication Error: No valid authentication found!

You need to set one of these environment variables in your GitLab CI/CD settings:
- ANTHROPIC_API_KEY (from https://console.anthropic.com/)
- CLAUDE_CODE_OAUTH_TOKEN (from Claude Code OAuth)

To set these in GitLab:
1. Go to your project → Settings → CI/CD
2. Expand 'Variables' section
3. Add new variable:
   - Key: ANTHROPIC_API_KEY
   - Value: [your API key]
   - Type: Variable (not File)
   - Protected: ✓
   - Masked: ✓
`;
    console.error(errorMsg);
    throw new Error("Authentication required but not found");
  }

  // Test authentication validity with a simple API call
  console.log("=== Testing Authentication Validity ===");
  try {
    const testEnv = {
      ...process.env,
      ...config.env,
    };
    
    console.log("Testing Claude CLI authentication with simple prompt...");
    const testResult = await execAsync('echo "test" | timeout 30 claude --model sonnet -p', {
      env: testEnv,
      timeout: 35000, // 35 second timeout
    });
    
    if (testResult.stdout.includes("I'm Claude") || testResult.stdout.trim().length > 0) {
      console.log("✅ Authentication test successful - Claude CLI responded");
    } else {
      console.log("⚠️  Authentication test unclear - no clear response from Claude");
    }
  } catch (error: any) {
    const errorMsg = error.message || error.toString();
    
    if (errorMsg.includes("401") || errorMsg.includes("authentication")) {
      console.error("❌ Authentication test failed: Invalid API key or token");
      throw new Error("Authentication token is invalid or expired");
    } else if (errorMsg.includes("timeout") || error.code === 'ETIMEDOUT') {
      console.error("❌ Authentication test timed out - possible network or API issues");
      throw new Error("Unable to connect to Claude API within timeout period");
    } else if (errorMsg.includes("403")) {
      console.error("❌ Authentication test failed: Access forbidden - check API key permissions");
      throw new Error("API key does not have sufficient permissions");
    } else {
      console.error(`⚠️  Authentication test failed with error: ${errorMsg}`);
      console.error("Proceeding anyway, but Claude execution might fail...");
    }
  }

  // Output to console
  console.log(`Running Claude with prompt from file: ${config.promptPath}`);

  // Start sending prompt to pipe in background
  const catProcess = spawn("cat", [config.promptPath], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const pipeStream = createWriteStream(PIPE_PATH);
  catProcess.stdout.pipe(pipeStream);

  catProcess.on("error", (error) => {
    console.error("Error reading prompt file:", error);
    pipeStream.destroy();
  });

  console.log("Spawning Claude CLI process...");
  const claudeProcess = spawn("claude", config.claudeArgs, {
    stdio: ["pipe", "pipe", "pipe"], // Capture stderr separately
    env: {
      ...process.env,
      ...config.env,
    },
  });

  // Handle Claude process errors
  claudeProcess.on("error", (error: any) => {
    console.error("Error spawning Claude process:", error);
    pipeStream.destroy();
  });

  // Monitor Claude stderr for authentication errors
  claudeProcess.stderr?.on("data", (data: any) => {
    const errorText = data.toString();
    console.error(`Claude stderr: ${errorText}`);
    
    // Check for common authentication error patterns
    if (errorText.includes("401") || errorText.includes("Unauthorized") || 
        errorText.includes("Invalid API key") || errorText.includes("authentication failed")) {
      console.error("❌ Detected authentication error in Claude output");
    } else if (errorText.includes("403") || errorText.includes("Forbidden")) {
      console.error("❌ Detected permission error in Claude output");
    } else if (errorText.includes("timeout") || errorText.includes("connection")) {
      console.error("❌ Detected connection error in Claude output");
    }
  });

  // Add process spawn success indicator
  claudeProcess.on("spawn", () => {
    console.log("✅ Claude CLI process spawned successfully");
  });

  // Capture output for parsing execution metrics
  let output = "";
  claudeProcess.stdout.on("data", (data) => {
    const text = data.toString();

    // Try to parse as JSON and pretty print if it's on a single line
    const lines = text.split("\n");
    lines.forEach((line: string, index: number) => {
      if (line.trim() === "") return;

      try {
        // Check if this line is a JSON object
        const parsed = JSON.parse(line);
        const prettyJson = JSON.stringify(parsed, null, 2);
        process.stdout.write(prettyJson);
        if (index < lines.length - 1 || text.endsWith("\n")) {
          process.stdout.write("\n");
        }
      } catch (e) {
        // Not a JSON object, print as is
        process.stdout.write(line);
        if (index < lines.length - 1 || text.endsWith("\n")) {
          process.stdout.write("\n");
        }
      }
    });

    output += text;
  });

  // Handle stdout errors
  claudeProcess.stdout.on("error", (error) => {
    console.error("Error reading Claude stdout:", error);
  });

  // Pipe from named pipe to Claude
  const pipeProcess = spawn("cat", [PIPE_PATH]);
  pipeProcess.stdout.pipe(claudeProcess.stdin);

  // Handle pipe process errors
  pipeProcess.on("error", (error) => {
    console.error("Error reading from named pipe:", error);
    claudeProcess.kill("SIGTERM");
  });

  // Wait for Claude to finish with timeout
  let timeoutMs = 10 * 60 * 1000; // Default 10 minutes
  if (options.timeoutMinutes) {
    timeoutMs = parseInt(options.timeoutMinutes, 10) * 60 * 1000;
  } else if (process.env.INPUT_TIMEOUT_MINUTES) {
    const envTimeout = parseInt(process.env.INPUT_TIMEOUT_MINUTES, 10);
    if (isNaN(envTimeout) || envTimeout <= 0) {
      throw new Error(
        `INPUT_TIMEOUT_MINUTES must be a positive number, got: ${process.env.INPUT_TIMEOUT_MINUTES}`,
      );
    }
    timeoutMs = envTimeout * 60 * 1000;
  }
  const exitCode = await new Promise<number>((resolve) => {
    let resolved = false;

    // Set a timeout for the process
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        console.error(
          `Claude process timed out after ${timeoutMs / 1000} seconds`,
        );
        claudeProcess.kill("SIGTERM");
        // Give it 5 seconds to terminate gracefully, then force kill
        setTimeout(() => {
          try {
            claudeProcess.kill("SIGKILL");
          } catch (e) {
            // Process may already be dead
          }
        }, 5000);
        resolved = true;
        resolve(124); // Standard timeout exit code
      }
    }, timeoutMs);

    claudeProcess.on("close", (code) => {
      if (!resolved) {
        clearTimeout(timeoutId);
        resolved = true;
        resolve(code || 0);
      }
    });

    claudeProcess.on("error", (error) => {
      if (!resolved) {
        console.error("Claude process error:", error);
        clearTimeout(timeoutId);
        resolved = true;
        resolve(1);
      }
    });
  });

  // Clean up processes
  try {
    catProcess.kill("SIGTERM");
  } catch (e) {
    // Process may already be dead
  }
  try {
    pipeProcess.kill("SIGTERM");
  } catch (e) {
    // Process may already be dead
  }

  // Clean up pipe file
  try {
    await unlink(PIPE_PATH);
  } catch (e) {
    // Ignore errors during cleanup
  }

  // Set conclusion based on exit code
  if (exitCode === 0) {
    // Try to process the output and save execution metrics
    try {
      await writeFile("output.txt", output);

      // Process output.txt into JSON and save to execution file
      const { stdout: jsonOutput } = await execAsync("jq -s '.' output.txt");
      await writeFile(EXECUTION_FILE, jsonOutput);

      console.log(`Log saved to ${EXECUTION_FILE}`);
    } catch (e) {
      core.warning(`Failed to process output for execution metrics: ${e}`);
    }

    core.setOutput("conclusion", "success");
    core.setOutput("execution_file", EXECUTION_FILE);
  } else {
    core.setOutput("conclusion", "failure");

    // Still try to save execution file if we have output
    if (output) {
      try {
        await writeFile("output.txt", output);
        const { stdout: jsonOutput } = await execAsync("jq -s '.' output.txt");
        await writeFile(EXECUTION_FILE, jsonOutput);
        core.setOutput("execution_file", EXECUTION_FILE);
      } catch (e) {
        // Ignore errors when processing output during failure
      }
    }

    process.exit(exitCode);
  }
}

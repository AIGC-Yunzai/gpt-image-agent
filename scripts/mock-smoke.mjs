import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expandHomeDirectory } from "../server/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(__filename), "..");
const tmpDir = path.join(pluginRoot, ".tmp", "mock-smoke");
const defaultOutputDir = path.join(tmpDir, "default-out");
const generateOutputDir = path.join(tmpDir, "generate-out");
const batchOutputDir = path.join(tmpDir, "batch-out");
const editOutputDir = path.join(tmpDir, "edit-out");
const configPath = path.join(tmpDir, "config.json");
const sourceImagePath = path.join(tmpDir, "source.png");
const unusableOutputPath = path.join(tmpDir, "not-a-directory");
const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function startMockServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await collectBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });

    assert.equal(req.headers.authorization, "Bearer test-key");

    let count = 1;
    if (req.url === "/v1/images/generations") {
      const json = JSON.parse(body.toString("utf8"));
      count = Number(json.n || 1);
      assert.ok(json.prompt);
      assert.equal(json.model, "gpt-image-2");
    } else if (req.url === "/v1/images/edits") {
      const text = body.toString("latin1");
      assert.match(req.headers["content-type"], /multipart\/form-data/);
      assert.match(text, /name="prompt"/);
      assert.match(text, /name="image"/);
    } else {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: Array.from({ length: count }, (_, index) => ({
        b64_json: png1x1.toString("base64"),
        revised_prompt: `mock revised ${index + 1}`,
      })),
    }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function main() {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(sourceImagePath, png1x1);
  await fs.writeFile(unusableOutputPath, "this file cannot be used as an output directory");

  const mock = await startMockServer();
  await fs.writeFile(configPath, JSON.stringify({
    baseUrl: mock.baseUrl,
    apiKey: "test-key",
    model: "gpt-image-2",
    outputDir: defaultOutputDir,
    defaultSize: "1024x1024",
    defaultQuality: "medium",
    defaultOutputFormat: "png",
    proxyUrl: "",
    requestTimeoutMs: 30000,
    maxBatchJobs: 20,
    maxBatchConcurrency: 2,
    maxTotalImagesPerBatch: 50,
  }, null, 2));

  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(pluginRoot, "server", "index.mjs")],
    env: {
      ...process.env,
      GPT_IMAGE_AGENT_CONFIG: configPath,
      MISAKA_GPT_IMAGE_API_KEY: "",
    },
  });
  const client = new Client({ name: "misaka-gpt-image-agent-smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "edit_image",
    "generate_image",
    "generate_image_batch",
  ]);
  const batchTool = tools.tools.find((tool) => tool.name === "generate_image_batch");
  assert.ok(batchTool.inputSchema.properties.outputDir);
  assert.equal(batchTool.inputSchema.properties.jobs.items.properties.outputDir, undefined);

  for (const request of [
    {
      name: "generate_image",
      arguments: {
        prompt: "must not reach the image API",
        outputDir: unusableOutputPath,
      },
    },
    {
      name: "generate_image_batch",
      arguments: {
        jobs: [{ prompt: "must not reach the batch image API" }],
        outputDir: unusableOutputPath,
      },
    },
    {
      name: "edit_image",
      arguments: {
        imagePaths: [sourceImagePath],
        prompt: "must not reach the edit image API",
        outputDir: unusableOutputPath,
      },
    },
  ]) {
    const invalidOutput = await client.callTool(request);
    const invalidOutputJson = JSON.parse(invalidOutput.content[0].text);
    assert.equal(invalidOutput.isError, true);
    assert.equal(invalidOutputJson.ok, false);
    assert.match(invalidOutputJson.error, /Output directory is not usable/);
    assert.match(invalidOutputJson.error, new RegExp(unusableOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(mock.requests.length, 0, "output paths must be checked before API requests");

  const generated = await client.callTool({
    name: "generate_image",
    arguments: {
      prompt: "mock cat",
      n: 2,
      outputName: "mock-cat",
      outputDir: generateOutputDir,
    },
  });
  const generatedJson = JSON.parse(generated.content[0].text);
  assert.equal(generatedJson.ok, true, generated.content[0].text);
  assert.equal(generatedJson.images.length, 2);
  assert.equal(generatedJson.outputDir, generateOutputDir);

  const defaultGenerated = await client.callTool({
    name: "generate_image",
    arguments: {
      prompt: "mock default output",
      outputName: "default-output",
    },
  });
  const defaultGeneratedJson = JSON.parse(defaultGenerated.content[0].text);
  assert.equal(defaultGeneratedJson.outputDir, defaultOutputDir);

  const batch = await client.callTool({
    name: "generate_image_batch",
    arguments: {
      jobs: [
        { prompt: "mock landscape", outputName: "landscape" },
        { prompt: "mock portrait", outputName: "portrait" },
      ],
      concurrency: 2,
      outputDir: batchOutputDir,
    },
  });
  const batchJson = JSON.parse(batch.content[0].text);
  assert.equal(batchJson.ok, true);
  assert.equal(batchJson.jobs.length, 2);
  assert.equal(batchJson.outputDir, batchOutputDir);
  assert.ok(batchJson.imagePaths.every((outPath) => outPath.startsWith(batchOutputDir)));

  const edited = await client.callTool({
    name: "edit_image",
    arguments: {
      imagePaths: [sourceImagePath],
      prompt: "turn it blue",
      outputName: "edited",
      outputDir: editOutputDir,
    },
  });
  const editedJson = JSON.parse(edited.content[0].text);
  assert.equal(editedJson.images.length, 1);
  assert.equal(editedJson.outputDir, editOutputDir);
  assert.ok(editedJson.images.every((image) => image.path.startsWith(editOutputDir)));

  assert.equal(expandHomeDirectory("~"), os.homedir());
  assert.equal(expandHomeDirectory("~/.codex/test-output"), path.join(os.homedir(), ".codex", "test-output"));

  const allPaths = [
    ...generatedJson.images.map((image) => image.path),
    ...defaultGeneratedJson.images.map((image) => image.path),
    ...batchJson.imagePaths,
    ...editedJson.images.map((image) => image.path),
  ];
  for (const outPath of allPaths) {
    const stat = await fs.stat(outPath);
    assert.ok(stat.size > 0);
  }

  assert.equal(
    mock.requests.filter((request) => request.url === "/v1/images/generations").length,
    4,
    JSON.stringify(mock.requests.map((request) => request.url))
  );
  assert.equal(mock.requests.filter((request) => request.url === "/v1/images/edits").length, 1);

  await client.close();
  await new Promise((resolve) => mock.server.close(resolve));
  console.log(JSON.stringify({
    ok: true,
    requests: mock.requests.length,
    outputDir: defaultOutputDir,
    files: allPaths,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

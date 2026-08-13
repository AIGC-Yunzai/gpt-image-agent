import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const configPath = process.env.GPT_IMAGE_AGENT_CONFIG
  ? path.resolve(process.env.GPT_IMAGE_AGENT_CONFIG)
  : path.join(pluginRoot, "config", "config.json");

const API_KEY_ENV = "MISAKA_GPT_IMAGE_API_KEY";
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const GPT_IMAGE_2 = "gpt-image-2";
const DEFAULT_CONFIG = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: GPT_IMAGE_2,
  outputDir: path.join(process.env.USERPROFILE || pluginRoot, ".codex", "generated_images", "misaka-gpt-image-agent"),
  defaultSize: "1024x1024",
  defaultQuality: "medium",
  defaultOutputFormat: "png",
  proxyUrl: "",
  requestTimeoutMs: 600000,
  maxBatchJobs: 20,
  maxBatchConcurrency: 3,
  maxTotalImagesPerBatch: 50,
};

const QualitySchema = z.enum(["low", "medium", "high", "auto"]);
const OutputFormatSchema = z.enum(["png", "jpeg", "jpg", "webp"]);
const ModerationSchema = z.enum(["auto", "low"]);

const GenerateArgsSchema = z.object({
  prompt: z.string().trim().min(1),
  size: z.string().trim().min(1).optional(),
  quality: QualitySchema.optional(),
  outputFormat: OutputFormatSchema.optional(),
  outputCompression: z.coerce.number().int().min(0).max(100).optional(),
  n: z.coerce.number().int().min(1).max(10).optional(),
  outputName: z.string().trim().min(1).optional(),
  outputDir: z.string().trim().min(1).optional(),
  moderation: ModerationSchema.optional(),
}).strip();

const BatchJobSchema = GenerateArgsSchema.omit({ outputDir: true }).extend({
  outputName: z.string().trim().min(1).optional(),
});

const BatchArgsSchema = z.object({
  jobs: z.array(BatchJobSchema).min(1),
  concurrency: z.coerce.number().int().min(1).optional(),
  failFast: z.boolean().optional(),
  outputDir: z.string().trim().min(1).optional(),
}).strip();

const EditArgsSchema = z.object({
  imagePaths: z.array(z.string().trim().min(1)).min(1).max(16),
  prompt: z.string().trim().min(1),
  maskPath: z.string().trim().min(1).optional(),
  size: z.string().trim().min(1).optional(),
  quality: QualitySchema.optional(),
  outputFormat: OutputFormatSchema.optional(),
  n: z.coerce.number().int().min(1).max(10).optional(),
  outputName: z.string().trim().min(1).optional(),
  outputDir: z.string().trim().min(1).optional(),
  moderation: ModerationSchema.optional(),
}).strip();

class UpstreamError extends Error {
  constructor(statusCode, bodyText, requestUrl) {
    super(`Image API returned HTTP ${statusCode}: ${bodyText.slice(0, 1000)}`);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
    this.requestUrl = requestUrl;
    this.bodyText = bodyText;
  }
}

function log(message) {
  console.error(`[misaka-gpt-image-agent] ${message}`);
}

async function readJsonFile(file) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

async function loadConfig() {
  let fileConfig = {};
  try {
    fileConfig = await readJsonFile(configPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Failed to read config ${configPath}: ${error.message}`);
    }
  }

  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
  };

  if (process.env.MISAKA_GPT_IMAGE_BASE_URL) {
    config.baseUrl = process.env.MISAKA_GPT_IMAGE_BASE_URL;
  }
  if (process.env.MISAKA_GPT_IMAGE_OUTPUT_DIR) {
    config.outputDir = process.env.MISAKA_GPT_IMAGE_OUTPUT_DIR;
  }
  if (process.env.MISAKA_GPT_IMAGE_PROXY_URL) {
    config.proxyUrl = process.env.MISAKA_GPT_IMAGE_PROXY_URL;
  }

  config.baseUrl = normalizeBaseUrl(config.baseUrl);
  config.outputDir = resolveOutputDir(config.outputDir);
  config.defaultOutputFormat = normalizeOutputFormat(config.defaultOutputFormat);

  if (config.model !== GPT_IMAGE_2) {
    throw new Error(`This plugin only supports ${GPT_IMAGE_2}; config model is ${config.model}`);
  }

  validateSize(config.defaultSize);
  validateQuality(config.defaultQuality);
  await fs.mkdir(config.outputDir, { recursive: true });
  return config;
}

export function expandHomeDirectory(value) {
  const raw = String(value || "").trim();
  if (raw === "~") {
    return os.homedir();
  }
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function resolveOutputDir(value) {
  return path.resolve(expandHomeDirectory(value));
}

function outputDirForCall(config, args) {
  return args.outputDir ? resolveOutputDir(args.outputDir) : config.outputDir;
}

async function ensureOutputDirUsable(outputDir) {
  const probePath = path.join(
    outputDir,
    `.misaka-gpt-image-agent-write-test-${process.pid}-${randomUUID()}.tmp`
  );

  try {
    await fs.mkdir(outputDir, { recursive: true });
    const stat = await fs.stat(outputDir);
    if (!stat.isDirectory()) {
      throw new Error("path exists but is not a directory");
    }
    await fs.writeFile(probePath, "write-test", { flag: "wx" });
    await fs.unlink(probePath);
  } catch (error) {
    try {
      await fs.unlink(probePath);
    } catch {
      // Ignore cleanup failures and report the original usability error.
    }
    const reason = error?.code ? `${error.code}: ${error.message}` : error.message;
    throw new Error(`Output directory is not usable: ${outputDir}. ${reason}`);
  }
}

function normalizeBaseUrl(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("config.baseUrl is required");
  }
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/v1")) {
    url.pathname = `${url.pathname}/v1`.replace(/\/{2,}/g, "/");
  }
  return url.toString().replace(/\/+$/, "");
}

function endpointUrl(config, endpoint) {
  return `${config.baseUrl}${endpoint}`;
}

function normalizeOutputFormat(value) {
  const fmt = String(value || "png").toLowerCase();
  if (fmt === "jpg") {
    return "jpeg";
  }
  if (!["png", "jpeg", "webp"].includes(fmt)) {
    throw new Error("outputFormat must be png, jpeg, jpg, or webp");
  }
  return fmt;
}

function validateQuality(value) {
  if (!["low", "medium", "high", "auto"].includes(value)) {
    throw new Error("quality must be one of low, medium, high, or auto");
  }
}

function parseSize(size) {
  const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(size);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2])];
}

function validateSize(size) {
  if (size === "auto") {
    return;
  }
  const parsed = parseSize(size);
  if (!parsed) {
    throw new Error("size must be auto or WIDTHxHEIGHT, for example 1024x1024");
  }

  const [width, height] = parsed;
  const maxEdge = Math.max(width, height);
  const minEdge = Math.min(width, height);
  const totalPixels = width * height;

  if (maxEdge > 3840) {
    throw new Error("gpt-image-2 size maximum edge length must be <= 3840");
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error("gpt-image-2 size width and height must be multiples of 16");
  }
  if (maxEdge / minEdge > 3) {
    throw new Error("gpt-image-2 size long-to-short ratio must be <= 3:1");
  }
  if (totalPixels < 655360 || totalPixels > 8294400) {
    throw new Error("gpt-image-2 size total pixels must be between 655360 and 8294400");
  }
}

function rejectUnsupportedOptions(raw) {
  if (!raw || typeof raw !== "object") {
    return;
  }
  if (raw.background === "transparent") {
    throw new Error("gpt-image-2 does not support background=transparent");
  }
  if ("input_fidelity" in raw || "inputFidelity" in raw) {
    throw new Error("gpt-image-2 does not support input_fidelity; image inputs always use high fidelity");
  }
}

function parseArgs(schema, raw) {
  rejectUnsupportedOptions(raw);
  const result = schema.safeParse(raw || {});
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid tool arguments: ${details}`);
  }
  return result.data;
}

function getApiKey(config) {
  const key = config.apiKey || process.env[API_KEY_ENV];
  if (!key || !key.trim()) {
    throw new Error(`config.apiKey is not set and ${API_KEY_ENV} is not set`);
  }
  return key.trim();
}

function omitUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
}

function sanitizeStem(value, fallback) {
  const raw = value ? path.basename(value, path.extname(value)) : fallback;
  const sanitized = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  return sanitized || fallback;
}

function promptSlug(prompt) {
  return sanitizeStem(prompt.slice(0, 80), "image").toLowerCase();
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function uniqueOutputPath(outputDir, stem, ext) {
  await fs.mkdir(outputDir, { recursive: true });
  for (let i = 0; i < 10000; i += 1) {
    const suffix = i === 0 ? "" : `-${i + 1}`;
    const candidate = path.join(outputDir, `${stem}${suffix}.${ext}`);
    try {
      await fs.access(candidate);
    } catch (error) {
      if (error.code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
  throw new Error("Unable to find a unique output filename");
}

function buildOutputStem(args, index, context = {}) {
  const base = sanitizeStem(
    args.outputName,
    `${context.prefix || timestampSlug()}-${promptSlug(args.prompt)}`
  );
  if ((args.n || 1) > 1) {
    return `${base}-${index + 1}`;
  }
  return base;
}

function contentTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  throw new Error(`Unsupported image extension for ${filePath}; use png, jpg, jpeg, or webp`);
}

async function validateImageFile(filePath) {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error(`Image path is not a file: ${resolved}`);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image file exceeds 50MB limit: ${resolved}`);
  }
  return {
    path: resolved,
    size: stat.size,
    contentType: contentTypeForPath(resolved),
    buffer: await fs.readFile(resolved),
  };
}

function validateOutputCompression(outputFormat, outputCompression) {
  if (outputCompression === undefined) {
    return;
  }
  if (!["jpeg", "webp"].includes(outputFormat)) {
    throw new Error("outputCompression is only valid for jpeg or webp output");
  }
}

function buildGeneratePayload(config, args) {
  const outputFormat = normalizeOutputFormat(args.outputFormat || config.defaultOutputFormat);
  const size = args.size || config.defaultSize;
  const quality = args.quality || config.defaultQuality;
  validateSize(size);
  validateQuality(quality);
  validateOutputCompression(outputFormat, args.outputCompression);

  return {
    payload: omitUndefined({
      model: config.model,
      prompt: args.prompt,
      n: args.n || 1,
      size,
      quality,
      output_format: outputFormat,
      output_compression: args.outputCompression,
      moderation: args.moderation,
    }),
    outputFormat,
    size,
    quality,
  };
}

function buildEditFields(config, args) {
  const outputFormat = normalizeOutputFormat(args.outputFormat || config.defaultOutputFormat);
  const size = args.size || config.defaultSize;
  const quality = args.quality || config.defaultQuality;
  validateSize(size);
  validateQuality(quality);

  return {
    fields: omitUndefined({
      model: config.model,
      prompt: args.prompt,
      n: args.n || 1,
      size,
      quality,
      output_format: outputFormat,
      moderation: args.moderation,
    }),
    outputFormat,
    size,
    quality,
  };
}

async function requestBuffer(requestUrl, options = {}) {
  const target = new URL(requestUrl);
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;
  const agent = options.proxyUrl && isHttps ? new HttpsProxyAgent(options.proxyUrl) : undefined;
  const headers = {
    "accept-encoding": "identity",
    ...(options.headers || {}),
  };
  if (options.body && !headers["content-length"] && !headers["Content-Length"]) {
    headers["content-length"] = Buffer.byteLength(options.body);
  }

  return await new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers,
      agent,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new UpstreamError(res.statusCode || 0, body.toString("utf8"), requestUrl));
          return;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(options.timeoutMs || DEFAULT_CONFIG.requestTimeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${options.timeoutMs || DEFAULT_CONFIG.requestTimeoutMs}ms`));
    });
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function requestJson(config, endpoint, body) {
  const requestUrl = endpointUrl(config, endpoint);
  const response = await requestBuffer(requestUrl, {
    method: "POST",
    timeoutMs: config.requestTimeoutMs,
    proxyUrl: config.proxyUrl,
    headers: {
      authorization: `Bearer ${getApiKey(config)}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: Buffer.from(JSON.stringify(body), "utf8"),
  });
  return JSON.parse(response.body.toString("utf8"));
}

function multipartEscape(value) {
  return String(value).replace(/"/g, "%22").replace(/\r|\n/g, " ");
}

function buildMultipart(fields, files) {
  const boundary = `----misaka-gpt-image-agent-${randomUUID()}`;
  const chunks = [];
  const push = (value) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));

  for (const [name, value] of Object.entries(fields)) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${multipartEscape(name)}"\r\n\r\n`);
    push(String(value));
    push("\r\n");
  }

  for (const file of files) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${multipartEscape(file.fieldName)}"; filename="${multipartEscape(path.basename(file.path))}"\r\n`);
    push(`Content-Type: ${file.contentType}\r\n\r\n`);
    push(file.buffer);
    push("\r\n");
  }

  push(`--${boundary}--\r\n`);
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function requestMultipart(config, endpoint, fields, files) {
  const { body, contentType } = buildMultipart(fields, files);
  const requestUrl = endpointUrl(config, endpoint);
  const response = await requestBuffer(requestUrl, {
    method: "POST",
    timeoutMs: config.requestTimeoutMs,
    proxyUrl: config.proxyUrl,
    headers: {
      authorization: `Bearer ${getApiKey(config)}`,
      accept: "application/json",
      "content-type": contentType,
    },
    body,
  });
  return JSON.parse(response.body.toString("utf8"));
}

async function saveImageResponse(config, response, args, meta, context = {}) {
  const data = Array.isArray(response.data) ? response.data : [];
  if (data.length === 0) {
    throw new Error("Image API response did not include data[]");
  }

  const images = [];
  for (let i = 0; i < data.length; i += 1) {
    const item = data[i];
    const stem = buildOutputStem(args, i, context);
    const outPath = await uniqueOutputPath(context.outputDir || config.outputDir, stem, meta.outputFormat);
    let bytes;
    let source = "b64_json";

    if (item?.b64_json) {
      bytes = Buffer.from(item.b64_json, "base64");
    } else if (item?.url) {
      source = "url";
      const downloaded = await requestBuffer(item.url, {
        method: "GET",
        timeoutMs: config.requestTimeoutMs,
        proxyUrl: config.proxyUrl,
      });
      bytes = downloaded.body;
    } else {
      throw new Error(`Image API response item ${i + 1} had neither b64_json nor url`);
    }

    await fs.writeFile(outPath, bytes);
    images.push({
      index: i + 1,
      path: outPath,
      bytes: bytes.length,
      source,
      revisedPrompt: item?.revised_prompt,
    });
  }

  return images;
}

async function runGenerate(config, rawArgs, context = {}) {
  const args = parseArgs(GenerateArgsSchema, rawArgs);
  const request = buildGeneratePayload(config, args);
  const outputDir = outputDirForCall(config, args);
  await ensureOutputDirUsable(outputDir);
  const response = await requestJson(config, "/images/generations", request.payload);
  const images = await saveImageResponse(config, response, args, request, { ...context, outputDir });

  return {
    ok: true,
    operation: context.operation || "generate_image",
    model: config.model,
    endpoint: "/v1/images/generations",
    prompt: args.prompt,
    size: request.size,
    quality: request.quality,
    outputFormat: request.outputFormat,
    outputDir,
    images,
  };
}

async function runEdit(config, rawArgs) {
  const args = parseArgs(EditArgsSchema, rawArgs);
  const request = buildEditFields(config, args);
  const outputDir = outputDirForCall(config, args);
  await ensureOutputDirUsable(outputDir);
  const imageFiles = [];
  for (const imagePath of args.imagePaths) {
    imageFiles.push({
      ...(await validateImageFile(imagePath)),
      fieldName: "image",
    });
  }

  const files = [...imageFiles];
  if (args.maskPath) {
    files.push({
      ...(await validateImageFile(args.maskPath)),
      fieldName: "mask",
    });
  }

  const response = await requestMultipart(config, "/images/edits", request.fields, files);
  const images = await saveImageResponse(config, response, args, request, { outputDir });

  return {
    ok: true,
    operation: "edit_image",
    model: config.model,
    endpoint: "/v1/images/edits",
    prompt: args.prompt,
    sourceImages: imageFiles.map((file) => file.path),
    maskPath: args.maskPath ? path.resolve(args.maskPath) : undefined,
    size: request.size,
    quality: request.quality,
    outputFormat: request.outputFormat,
    outputDir,
    images,
  };
}

async function runBatch(config, rawArgs) {
  const args = parseArgs(BatchArgsSchema, rawArgs);
  const totalImages = args.jobs.reduce((sum, job) => sum + (job.n || 1), 0);
  if (args.jobs.length > config.maxBatchJobs) {
    throw new Error(`Batch has ${args.jobs.length} jobs; maxBatchJobs is ${config.maxBatchJobs}`);
  }
  if (totalImages > config.maxTotalImagesPerBatch) {
    throw new Error(`Batch would create ${totalImages} images; maxTotalImagesPerBatch is ${config.maxTotalImagesPerBatch}`);
  }

  const outputDir = outputDirForCall(config, args);
  await ensureOutputDirUsable(outputDir);
  const concurrency = Math.min(args.concurrency || config.maxBatchConcurrency, config.maxBatchConcurrency);
  const results = new Array(args.jobs.length);
  let nextIndex = 0;
  let failed = false;

  async function worker() {
    while (nextIndex < args.jobs.length) {
      if (failed && args.failFast) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      const job = args.jobs[index];
      const outputName = job.outputName || `${String(index + 1).padStart(3, "0")}-${promptSlug(job.prompt)}`;
      try {
        const result = await runGenerate(config, { ...job, outputName, outputDir: args.outputDir }, {
          operation: "generate_image_batch",
          prefix: `${String(index + 1).padStart(3, "0")}-${timestampSlug()}`,
        });
        results[index] = {
          index: index + 1,
          ok: true,
          result,
        };
      } catch (error) {
        failed = true;
        results[index] = {
          index: index + 1,
          ok: false,
          error: error.message,
          prompt: job.prompt,
        };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const imagePaths = results
    .filter((item) => item?.ok)
    .flatMap((item) => item.result.images.map((image) => image.path));

  return {
    ok: results.every((item) => item?.ok),
    operation: "generate_image_batch",
    model: config.model,
    endpoint: "/v1/images/generations",
    concurrency,
    totalJobs: args.jobs.length,
    totalImages,
    outputDir,
    imagePaths,
    jobs: results,
  };
}

const generateImageTool = {
  name: "generate_image",
  description: "Generate images from a text prompt using gpt-image-2. Requests may take several minutes; this server is configured with a 600-second tool timeout. Returns absolute output paths. Set outputDir to a writable local directory for this request when the configured default is unavailable.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text prompt for the image." },
      size: { type: "string", description: "auto or WIDTHxHEIGHT. Examples: 1024x1024, 2048x1152, 3840x2160." },
      quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
      outputFormat: { type: "string", enum: ["png", "jpeg", "jpg", "webp"] },
      outputCompression: { type: "integer", minimum: 0, maximum: 100, description: "Only for jpeg/webp." },
      n: { type: "integer", minimum: 1, maximum: 10 },
      outputName: { type: "string", description: "Optional output filename stem." },
      outputDir: { type: "string", description: "Optional writable local directory for this request's output files. Overrides configured outputDir." },
      moderation: { type: "string", enum: ["auto", "low"] },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

const batchJobInputSchema = {
  ...generateImageTool.inputSchema,
  properties: Object.fromEntries(
    Object.entries(generateImageTool.inputSchema.properties).filter(([name]) => name !== "outputDir")
  ),
};

const generateImageBatchTool = {
  name: "generate_image_batch",
  description: "Generate many prompt jobs with gpt-image-2 using bounded concurrency. Requests may take several minutes; this server is configured with a 600-second tool timeout. Returns absolute output paths. Set outputDir to one writable local directory for all jobs in this batch.",
  inputSchema: {
    type: "object",
    properties: {
      jobs: {
        type: "array",
        minItems: 1,
        items: batchJobInputSchema,
      },
      concurrency: { type: "integer", minimum: 1 },
      failFast: { type: "boolean" },
      outputDir: { type: "string", description: "Optional writable local directory for every job's output files. Overrides configured outputDir." },
    },
    required: ["jobs"],
    additionalProperties: false,
  },
};

const editImageTool = {
  name: "edit_image",
  description: "Edit one or more local image files with gpt-image-2. Requests may take several minutes; this server is configured with a 600-second tool timeout. Returns absolute output paths. Set outputDir to a writable local directory for this request when the configured default is unavailable.",
  inputSchema: {
    type: "object",
    properties: {
      imagePaths: {
        type: "array",
        minItems: 1,
        maxItems: 16,
        items: { type: "string" },
        description: "Local paths to input images.",
      },
      prompt: { type: "string", description: "Edit instruction." },
      maskPath: { type: "string", description: "Optional local mask image path. Applies to the first image." },
      size: { type: "string", description: "auto or WIDTHxHEIGHT." },
      quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
      outputFormat: { type: "string", enum: ["png", "jpeg", "jpg", "webp"] },
      n: { type: "integer", minimum: 1, maximum: 10 },
      outputName: { type: "string", description: "Optional output filename stem." },
      outputDir: { type: "string", description: "Optional writable local directory for this request's output files. Overrides configured outputDir." },
      moderation: { type: "string", enum: ["auto", "low"] },
    },
    required: ["imagePaths", "prompt"],
    additionalProperties: false,
  },
};

function toolResponse(result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

function toolError(error) {
  const result = {
    ok: false,
    error: error.message,
    name: error.name,
    statusCode: error.statusCode,
  };
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

async function main() {
  const config = await loadConfig();
  const server = new Server({
    name: "misaka-gpt-image-agent",
    version: "1.0.0",
  }, {
    capabilities: {
      tools: {},
    },
    instructions: "Use these tools to generate, batch-generate, and edit local image files with gpt-image-2. API keys come from config.apiKey, with MISAKA_GPT_IMAGE_API_KEY as a fallback.",
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [generateImageTool, generateImageBatchTool, editImageTool],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      if (name === "generate_image") {
        return toolResponse(await runGenerate(config, args));
      }
      if (name === "generate_image_batch") {
        return toolResponse(await runBatch(config, args));
      }
      if (name === "edit_image") {
        return toolResponse(await runEdit(config, args));
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      return toolError(error);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready; outputDir=${config.outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(`[misaka-gpt-image-agent] fatal: ${error.stack || error.message}`);
    process.exit(1);
  });
}

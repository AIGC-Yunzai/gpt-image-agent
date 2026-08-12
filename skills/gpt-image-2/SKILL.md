---
name: "gpt-image-2"
description: "Generate, batch-generate, or edit images through the local GPT Image Agent MCP tools backed by gpt-image-2. Use when the user asks Codex to create raster images, generate many image assets, or edit local image files with GPT Image 2."
---

# GPT Image 2

Directly call the registered `misaka-gpt-image-agent` MCP tools for image work. Do not create a temporary Node/MCP client, manually launch `server/index.mjs`, or rewrite `config/config.json` for an individual request.

- `generate_image` for one prompt.
- `generate_image_batch` for many prompt jobs.
- `edit_image` for local image file edits.

## Rules

- Use `gpt-image-2` by default.
- API keys are read from `config/config.json` as `apiKey`. `MISAKA_GPT_IMAGE_API_KEY` is only a fallback.
- Generated images are saved as local files. Report absolute output paths and render previews with Markdown image syntax when useful.
- Image generation and editing may take several minutes. The registered MCP server has a 600-second tool timeout; call the tool normally and allow it to finish rather than building a separate client with a shorter default timeout.
- Always pass `outputDir` with the absolute path of the user's intended working/project directory for every generation or edit. Prefer the current task workspace when the user has not named another output location; do not first try the configured default output folder. `generate_image_batch` accepts one top-level `outputDir` shared by every job; do not put `outputDir` inside individual jobs.
- Each successful result includes the effective `outputDir` and absolute paths for its output files.
- For exact dimensions, pass `size` as `WIDTHxHEIGHT`, for example `1024x1024`, `2048x1152`, `3840x2160`, or `2160x3840`.
- Use `quality: "low"` for drafts, `"medium"` for normal work, and `"high"` for final images.
- Do not ask for or pass transparent backgrounds with `gpt-image-2`; it does not support `background=transparent`.
- Do not pass `input_fidelity`; `gpt-image-2` always uses high fidelity for image inputs.
- For image edits, provide local file paths in `imagePaths`. If the target image is only in the conversation, save or locate it locally before calling `edit_image`.

## Prompting

Keep prompts specific enough to be useful, but do not add unrelated subjects, brands, text, or arbitrary story details. Include intended use, style, composition, lighting, constraints, and exact text only when they matter.

For batches, make one job per distinct asset. Use clear `outputName` values so filenames are useful.

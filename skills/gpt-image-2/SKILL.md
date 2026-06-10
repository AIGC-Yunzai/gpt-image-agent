---
name: "gpt-image-2"
description: "Generate, batch-generate, or edit images through the local GPT Image Agent MCP tools backed by gpt-image-2. Use when the user asks Codex to create raster images, generate many image assets, or edit local image files with GPT Image 2."
---

# GPT Image 2

Use the `gpt-image-agent` MCP tools for image work:

- `generate_image` for one prompt.
- `generate_image_batch` for many prompt jobs.
- `edit_image` for local image file edits.

## Rules

- Use `gpt-image-2` by default.
- API keys are read from `config/config.json` as `apiKey`. `MISAKA_GPT_IMAGE_API_KEY` is only a fallback.
- Generated images are saved as local files. Report absolute output paths and render previews with Markdown image syntax when useful.
- For exact dimensions, pass `size` as `WIDTHxHEIGHT`, for example `1024x1024`, `2048x1152`, `3840x2160`, or `2160x3840`.
- Use `quality: "low"` for drafts, `"medium"` for normal work, and `"high"` for final images.
- Do not ask for or pass transparent backgrounds with `gpt-image-2`; it does not support `background=transparent`.
- Do not pass `input_fidelity`; `gpt-image-2` always uses high fidelity for image inputs.
- For image edits, provide local file paths in `imagePaths`. If the target image is only in the conversation, save or locate it locally before calling `edit_image`.

## Prompting

Keep prompts specific enough to be useful, but do not add unrelated subjects, brands, text, or arbitrary story details. Include intended use, style, composition, lighting, constraints, and exact text only when they matter.

For batches, make one job per distinct asset. Use clear `outputName` values so filenames are useful.
